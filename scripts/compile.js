// Compiles contracts/*.sol with the npm `solc` package and writes artifacts in
// Hardhat's own artifact format directly into artifacts/. This sandbox blocks
// the network call Hardhat's own `compile` task normally makes to fetch the
// native solc binary (binaries.soliditylang.org isn't on the egress
// allowlist), so we drive solc ourselves from the npm-distributed compiler
// instead and hand Hardhat the result in the shape it expects. Run with
// `npm run build:contracts`, then `npx hardhat test --no-compile`.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const CONTRACTS_DIR = path.join(__dirname, "..", "contracts");
const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts", "contracts");

function findImports(importPath) {
  const resolved = path.join(CONTRACTS_DIR, importPath);
  if (fs.existsSync(resolved)) {
    return { contents: fs.readFileSync(resolved, "utf8") };
  }
  return { error: `File not found: ${importPath}` };
}

function compileFile(fileName) {
  const sourcePath = path.join(CONTRACTS_DIR, fileName);
  const source = fs.readFileSync(sourcePath, "utf8");

  const input = {
    language: "Solidity",
    sources: {
      [`contracts/${fileName}`]: { content: source },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] },
      },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const fatal = output.errors.filter((e) => e.severity === "error");
    for (const e of output.errors) {
      console.log(e.formattedMessage || e.message);
    }
    if (fatal.length > 0) {
      throw new Error(`Compilation failed with ${fatal.length} error(s)`);
    }
  }

  const sourceKey = `contracts/${fileName}`;
  const contracts = output.contracts[sourceKey];
  for (const contractName of Object.keys(contracts)) {
    const c = contracts[contractName];
    const outDir = path.join(ARTIFACTS_DIR, fileName);
    fs.mkdirSync(outDir, { recursive: true });

    const artifact = {
      _format: "hh-sol-artifact-1",
      contractName,
      sourceName: sourceKey,
      abi: c.abi,
      bytecode: "0x" + c.evm.bytecode.object,
      deployedBytecode: "0x" + c.evm.deployedBytecode.object,
      linkReferences: {},
      deployedLinkReferences: {},
    };

    fs.writeFileSync(
      path.join(outDir, `${contractName}.json`),
      JSON.stringify(artifact, null, 2)
    );
    console.log(`Compiled ${contractName} -> artifacts/contracts/${fileName}/${contractName}.json`);
  }
}

const solFiles = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));
for (const f of solFiles) {
  compileFile(f);
}
