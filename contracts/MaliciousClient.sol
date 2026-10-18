// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IMilestoneEscrow {
    function addMilestone(uint256 amount) external returns (uint256);
    function fundMilestone(uint256 id) external payable;
    function approveMilestone(uint256 id) external;
}

/// @title MaliciousClient
/// @notice TEST DOUBLE ONLY. A client that tries to re-enter the escrow from its
///         receive() hook while the arbiter's refund is being paid out. Used by the
///         test suite to prove the reentrancy guard (and checks-effects-interactions)
///         stop it. Never deploy this outside tests.
contract MaliciousClient {
    IMilestoneEscrow public escrow;
    bytes public lastReentryError;
    bool public reentryAttempted;

    function setEscrow(address _escrow) external {
        escrow = IMilestoneEscrow(_escrow);
    }

    function setup(uint256 amount) external payable {
        escrow.addMilestone(amount);
        escrow.fundMilestone{value: amount}(0);
    }

    receive() external payable {
        reentryAttempted = true;
        try escrow.approveMilestone(0) {
            lastReentryError = hex"";
        } catch (bytes memory err) {
            lastReentryError = err;
        }
    }
}
