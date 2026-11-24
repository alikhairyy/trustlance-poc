// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MilestoneEscrow
/// @notice Proof-of-concept escrow for a single freelance job, split into milestones.
///         A milestone releases automatically once the client approves it — unless
///         the off-chain AI risk engine has flagged that milestone first, in which
///         case release is held for human (arbiter) review. This is the hybrid
///         decision process described in the project proposal: automated for the
///         normal case, human review only when a risk alert or dispute appears.
///
/// @dev    Security model (see docs/SECURITY.md for the full threat table):
///         - Role separation: client, freelancer and arbiter must be three different
///           non-zero addresses, so nobody can act as both sides of a payment.
///         - Only the authorized risk oracle can post flags; the client can rotate it.
///         - The AI can DELAY a payment but never trap it: a flag only holds release
///           for REVIEW_WINDOW. A silent arbiter or a stolen oracle key therefore
///           cannot freeze funds forever, and re-flagging does not reset the clock.
///         - The flagged freelancer can appeal on-chain; every flag, appeal and
///           arbiter decision is emitted as an event, forming an audit trail.
///         - Emergency pause (arbiter) stops new activity, but the arbiter can still
///           settle open milestones so funds are never stuck behind a pause.
///         - Checks-effects-interactions on every transfer, plus a reentrancy guard.
///         This is a graduation-project proof of concept. It is NOT externally
///         audited and intentionally keeps scope narrow (ETH only, one arbiter,
///         no upgradability) so the core idea is easy to read, test, and demo.
contract MilestoneEscrow {
    enum Status {
        Pending, // milestone created, not yet funded
        Funded, // client has deposited the milestone amount
        Submitted, // freelancer has submitted work for review
        Released, // funds paid out to the freelancer
        Disputed, // client disputed the submission; awaiting arbiter
        Refunded // arbiter returned funds to the client
    }

    struct Milestone {
        uint256 amount;
        Status status;
        bool riskFlagged;
        string riskReason; // plain-language reason from the AI risk engine
        uint256 flaggedAt; // timestamp of the FIRST flag (starts the review window)
        bool appealed; // freelancer has appealed the flag
    }

    /// @notice How long a risk flag can hold a release before the client may approve anyway.
    uint256 public constant REVIEW_WINDOW = 7 days;
    /// @notice Cap on free-text length (flag reasons, appeal notes) to prevent gas/storage abuse.
    uint256 public constant MAX_TEXT_LENGTH = 512;

    address public immutable client;
    address public immutable freelancer;
    address public immutable arbiter; // platform-side human reviewer for this job
    address public riskOracle; // address authorized to post AI risk-engine flags
    bool public paused;

    Milestone[] public milestones;

    uint256 private _lock = 1; // reentrancy guard: 1 = open, 2 = entered

    event MilestoneAdded(uint256 indexed id, uint256 amount);
    event MilestoneFunded(uint256 indexed id, uint256 amount);
    event WorkSubmitted(uint256 indexed id);
    event RiskFlagged(uint256 indexed id, string reason);
    event FlagAppealed(uint256 indexed id, string note);
    event ArbiterDecided(uint256 indexed id, bool releasedToFreelancer, bool wasFlagged, bool wasAppealed);
    event MilestoneReleased(uint256 indexed id, address indexed to, uint256 amount, bool viaArbiter);
    event MilestoneDisputed(uint256 indexed id);
    event ChangesRequested(uint256 indexed id);
    event MilestoneRefunded(uint256 indexed id, address indexed to, uint256 amount);
    event RiskOracleUpdated(address indexed newOracle);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error NotClient();
    error NotFreelancer();
    error NotArbiter();
    error NotRiskOracle();
    error InvalidMilestone();
    error WrongStatus(Status current);
    error WrongFundingAmount(uint256 expected, uint256 sent);
    error ReleaseHeldForReview();
    error ZeroAddress();
    error InvalidParties();
    error ZeroAmount();
    error TextTooLong();
    error ContractPaused();
    error NotPaused();
    error Reentrancy();
    error NotFlagged();
    error AlreadyAppealed();
    error NotUnderReview();

    modifier onlyClient() {
        if (msg.sender != client) revert NotClient();
        _;
    }

    modifier onlyFreelancer() {
        if (msg.sender != freelancer) revert NotFreelancer();
        _;
    }

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    modifier onlyRiskOracle() {
        if (msg.sender != riskOracle) revert NotRiskOracle();
        _;
    }

    modifier validMilestone(uint256 id) {
        if (id >= milestones.length) revert InvalidMilestone();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address _client, address _freelancer, address _arbiter, address _riskOracle) {
        if (_client == address(0) || _freelancer == address(0) || _arbiter == address(0) || _riskOracle == address(0)) {
            revert ZeroAddress();
        }
        // Nobody may sit on both sides of a payment or review their own job.
        if (_client == _freelancer || _arbiter == _client || _arbiter == _freelancer) revert InvalidParties();
        client = _client;
        freelancer = _freelancer;
        arbiter = _arbiter;
        riskOracle = _riskOracle;
    }

    /// @notice Client defines a new milestone's price. Must be funded separately.
    function addMilestone(uint256 amount) external onlyClient whenNotPaused returns (uint256 id) {
        if (amount == 0) revert ZeroAmount();
        milestones.push(
            Milestone({
                amount: amount,
                status: Status.Pending,
                riskFlagged: false,
                riskReason: "",
                flaggedAt: 0,
                appealed: false
            })
        );
        id = milestones.length - 1;
        emit MilestoneAdded(id, amount);
    }

    /// @notice Client deposits the exact milestone amount into escrow.
    function fundMilestone(uint256 id) external payable onlyClient whenNotPaused validMilestone(id) {
        Milestone storage m = milestones[id];
        if (m.status != Status.Pending) revert WrongStatus(m.status);
        if (msg.value != m.amount) revert WrongFundingAmount(m.amount, msg.value);
        m.status = Status.Funded;
        emit MilestoneFunded(id, msg.value);
    }

    /// @notice Freelancer marks a funded milestone as delivered.
    function submitWork(uint256 id) external onlyFreelancer whenNotPaused validMilestone(id) {
        Milestone storage m = milestones[id];
        if (m.status != Status.Funded) revert WrongStatus(m.status);
        m.status = Status.Submitted;
        emit WorkSubmitted(id);
    }

    /// @notice The off-chain AI risk engine posts a flag + plain-language reason.
    ///         Recording the reason on-chain keeps the "why" auditable, not just
    ///         the score itself. Can be called any time before release.
    /// @dev    The review window starts at the FIRST flag only. Re-flagging updates
    ///         the reason but cannot restart the clock, so a compromised oracle
    ///         cannot hold a payment indefinitely.
    function flagRisk(uint256 id, string calldata reason) external onlyRiskOracle whenNotPaused validMilestone(id) {
        if (bytes(reason).length > MAX_TEXT_LENGTH) revert TextTooLong();
        Milestone storage m = milestones[id];
        if (m.status == Status.Released || m.status == Status.Refunded) revert WrongStatus(m.status);
        if (!m.riskFlagged) {
            m.flaggedAt = block.timestamp;
        }
        m.riskFlagged = true;
        m.riskReason = reason;
        emit RiskFlagged(id, reason);
    }

    /// @notice Freelancer contests a risk flag. The note goes on-chain for the
    ///         arbiter (and anyone auditing later); it does not release funds by itself.
    function appealFlag(uint256 id, string calldata note) external onlyFreelancer whenNotPaused validMilestone(id) {
        if (bytes(note).length > MAX_TEXT_LENGTH) revert TextTooLong();
        Milestone storage m = milestones[id];
        if (!m.riskFlagged) revert NotFlagged();
        if (m.status != Status.Funded && m.status != Status.Submitted) revert WrongStatus(m.status);
        if (m.appealed) revert AlreadyAppealed();
        m.appealed = true;
        emit FlagAppealed(id, note);
    }

    /// @notice Client approves submitted work. Releases immediately UNLESS the
    ///         milestone was risk-flagged and the review window is still open, in
    ///         which case it is held for the arbiter — the automated/human split.
    ///         Once the window has passed without an arbiter decision, the client's
    ///         own approval is honored: the AI can delay a payment, never trap it.
    function approveMilestone(uint256 id) external onlyClient whenNotPaused nonReentrant validMilestone(id) {
        Milestone storage m = milestones[id];
        if (m.status != Status.Submitted) revert WrongStatus(m.status);
        if (m.riskFlagged && block.timestamp < m.flaggedAt + REVIEW_WINDOW) revert ReleaseHeldForReview();
        _release(id, false);
    }

    /// @notice Client asks for changes instead of approving or disputing. The work goes
    ///         back to the freelancer (Funded) so it can be submitted again; the money
    ///         stays locked. Not allowed once the risk oracle has flagged the milestone:
    ///         a flagged payment is the arbiter's to settle, and sending it back would let
    ///         a resubmission dodge the review.
    function requestChanges(uint256 id) external onlyClient whenNotPaused validMilestone(id) {
        Milestone storage m = milestones[id];
        if (m.status != Status.Submitted) revert WrongStatus(m.status);
        if (m.riskFlagged) revert ReleaseHeldForReview();
        m.status = Status.Funded;
        emit ChangesRequested(id);
    }

    /// @notice Client disputes submitted work instead of approving it.
    function disputeMilestone(uint256 id) external onlyClient whenNotPaused validMilestone(id) {
        Milestone storage m = milestones[id];
        if (m.status != Status.Submitted) revert WrongStatus(m.status);
        m.status = Status.Disputed;
        emit MilestoneDisputed(id);
    }

    /// @dev The arbiter decides only what is put in front of them: a disputed milestone,
    ///      or submitted work the risk oracle flagged. During an emergency pause the
    ///      arbiter may also settle any submitted work, so funds are never stuck.
    ///      Ordinary submitted work stays the client's decision.
    function _requireUnderReview(Milestone storage m) private view {
        if (m.status == Status.Disputed) return;
        if (m.status != Status.Submitted) revert WrongStatus(m.status);
        if (!m.riskFlagged && !paused) revert NotUnderReview();
    }

    /// @notice Arbiter releases a risk-flagged or disputed milestone to the freelancer.
    function arbiterRelease(uint256 id) external onlyArbiter nonReentrant validMilestone(id) {
        Milestone storage m = milestones[id];
        _requireUnderReview(m);
        emit ArbiterDecided(id, true, m.riskFlagged, m.appealed);
        _release(id, true);
    }

    /// @notice Arbiter refunds a disputed or risk-flagged milestone to the client.
    function arbiterRefund(uint256 id) external onlyArbiter nonReentrant validMilestone(id) {
        Milestone storage m = milestones[id];
        _requireUnderReview(m);
        m.status = Status.Refunded; // effects before interaction
        emit ArbiterDecided(id, false, m.riskFlagged, m.appealed);
        (bool ok, ) = client.call{value: m.amount}("");
        require(ok, "refund transfer failed");
        emit MilestoneRefunded(id, client, m.amount);
    }

    /// @notice Emergency stop. Blocks new activity (funding, submissions, flags,
    ///         approvals) but NOT arbiter settlement, so open funds can still be resolved.
    function pause() external onlyArbiter {
        if (paused) revert ContractPaused();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyArbiter {
        if (!paused) revert NotPaused();
        paused = false;
        emit Unpaused(msg.sender);
    }

    /// @notice Rotate the risk-oracle address (e.g. if the AI service's signing key
    ///         is compromised or changes). Must be a real address.
    function setRiskOracle(address newOracle) external onlyClient {
        if (newOracle == address(0)) revert ZeroAddress();
        riskOracle = newOracle;
        emit RiskOracleUpdated(newOracle);
    }

    function milestoneCount() external view returns (uint256) {
        return milestones.length;
    }

    function getMilestone(uint256 id)
        external
        view
        validMilestone(id)
        returns (uint256 amount, Status status, bool riskFlagged, string memory riskReason)
    {
        Milestone storage m = milestones[id];
        return (m.amount, m.status, m.riskFlagged, m.riskReason);
    }

    /// @notice Review-window details for a milestone. reviewDeadline is 0 when not flagged.
    function getReviewInfo(uint256 id)
        external
        view
        validMilestone(id)
        returns (uint256 flaggedAt, bool appealed, uint256 reviewDeadline)
    {
        Milestone storage m = milestones[id];
        return (m.flaggedAt, m.appealed, m.riskFlagged ? m.flaggedAt + REVIEW_WINDOW : 0);
    }

    function _release(uint256 id, bool viaArbiter) private {
        Milestone storage m = milestones[id];
        m.status = Status.Released; // effects before interaction
        (bool ok, ) = freelancer.call{value: m.amount}("");
        require(ok, "release transfer failed");
        emit MilestoneReleased(id, freelancer, m.amount, viaArbiter);
    }
}
