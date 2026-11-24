// Utilities
const Utils = require("../utilities/Utils.js");
const {
  impersonates,
  setupCoreProtocol,
  depositVault,
} = require("../utilities/hh-utils.js");

const addresses = require("../test-config.js");
const BigNumber = require("bignumber.js");
const IERC20 = artifacts.require("IERC20");
const IAeroV2Dex = artifacts.require("IAeroV2Dex");
const IAeroV2Gauge = artifacts.require("IAeroV2Gauge");
const IAeroV2GaugeFactory = artifacts.require("IAeroV2GaugeFactory");
const IAeroV2LeafVoter = artifacts.require("IAeroV2LeafVoter");
const IAeroV2Pool = artifacts.require("IAeroV2Pool");
const IAeroV2PoolFactory = artifacts.require("IAeroV2PoolFactory");
const IUniversalLiquidator = artifacts.require("IUniversalLiquidator");
const IUniversalLiquidatorRegistry = artifacts.require("IUniversalLiquidatorRegistry");
const IWETH = artifacts.require("IWETH");
const StrategyProxy = artifacts.require("StrategyProxy");
const StableStrategy = artifacts.require("AerodromeV2StableStrategy");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeV2StableStrategyMainnet_USDC_alUSDb");

// GaugeFactory.sol functions that the strategy never calls (governance, gauge creation, constants), so
// IAeroV2GaugeFactory leaves them out
const gaugeFactoryGovernanceAbi = [
  { type: "function", name: "penaltyConfig", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", name: "",
    components: [{ type: "uint256", name: "minStakeBlocks" }, { type: "uint256", name: "penaltyRate" }] }] },
  { type: "function", name: "setPenaltyConfig", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "uint256", name: "_minStakeBlocksValue" }, { type: "uint256", name: "_penaltyRate" }] },
  { type: "function", name: "setEmissionCap", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address", name: "_gauge" }, { type: "uint128", name: "_cap" }] },
  { type: "function", name: "MAX_MIN_STAKE_BLOCKS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256", name: "" }] },
  { type: "function", name: "GAUGE_MANAGER", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "computeGaugeAddress", stateMutability: "view", inputs: [{ type: "address", name: "_pool" }],
    outputs: [{ type: "address", name: "_gauge" }] },
  { type: "function", name: "createGauge", stateMutability: "nonpayable",
    inputs: [{ type: "address", name: "_target" }, { type: "bytes", name: "_factoryData" }],
    outputs: [{ type: "address", name: "_gauge" }, { type: "address", name: "_rewards" }] },
];

// Pool.sol fee accounting that IAeroV2Pool leaves out (the strategy only calls claimFees)
const poolFeeAccountingAbi = [
  { type: "function", name: "poolFees", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "pendingFees", stateMutability: "view", inputs: [{ type: "address", name: "_account" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "function", name: "claimFees", stateMutability: "nonpayable", inputs: [{ type: "address", name: "_recipient" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "event", name: "Claim", anonymous: false, inputs: [{ indexed: true, type: "address", name: "caller" },
    { indexed: true, type: "address", name: "account" }, { indexed: true, type: "address", name: "recipient" },
    { indexed: false, type: "uint256", name: "amount0" }, { indexed: false, type: "uint256", name: "amount1" }] },
];

// Pool.sol swap bookkeeping that IAeroV2Pool leaves out: the strategy's own zap swaps and mints, and burn (the tests burn
// LP for pool tokens)
const poolSwapAbi = [
  { type: "function", name: "burn", stateMutability: "nonpayable", inputs: [{ type: "address", name: "to" }],
    outputs: [{ type: "uint256", name: "amount0" }, { type: "uint256", name: "amount1" }] },
  { type: "event", name: "Swap", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: true, type: "address", name: "to" }, { indexed: false, type: "uint256", name: "amount0In" },
    { indexed: false, type: "uint256", name: "amount1In" }, { indexed: false, type: "uint256", name: "amount0Out" },
    { indexed: false, type: "uint256", name: "amount1Out" }] },
  { type: "event", name: "Mint", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: true, type: "address", name: "to" }, { indexed: false, type: "uint256", name: "amount0" },
    { indexed: false, type: "uint256", name: "amount1" }] },
  { type: "event", name: "Fees", anonymous: false, inputs: [{ indexed: true, type: "address", name: "sender" },
    { indexed: false, type: "uint256", name: "amount0" }, { indexed: false, type: "uint256", name: "amount1" }] },
];

// PoolFactory.sol pool tape settings that IAeroV2PoolFactory leaves out: every pool swap records to the pool tape after
// Aero's gas check (recordPoolTape reverts InsufficientGasForCall while gasleft() <= poolTapeGasLimit)
const poolFactoryTapeAbi = [
  { type: "function", name: "poolTape", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "poolTapeGasLimit", stateMutability: "view", inputs: [], outputs: [{ type: "uint32", name: "" }] },
  { type: "function", name: "poolTapeManager", stateMutability: "view", inputs: [], outputs: [{ type: "address", name: "" }] },
  { type: "function", name: "setPoolTape", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address", name: "_poolTape" }, { type: "uint32", name: "_gasLimit" }] },
];

// V2Gauge.depositFor, which IAeroV2Gauge leaves out: while Aero enforces no window anyone can stake for the strategy
const gaugeDepositForAbi = [
  { type: "function", name: "depositFor", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "uint256", name: "_amount" }, { type: "address", name: "_owner" }] },
];

// LeafVoter.sol event that IAeroV2LeafVoter leaves out: AERO a gauge hands back (penalties, emissions nobody can earn)
const leafVoterEventsAbi = [
  { type: "event", name: "EmissionsForfeited", anonymous: false, inputs: [{ indexed: true, type: "address", name: "_gauge" },
    { indexed: false, type: "uint128", name: "_amount" }] },
];

// BaseUpgradeableStrategy and its storage contract both declare events with these names: query the ones the strategy
// emits by their signature
const profitLogInReward = web3.utils.keccak256("ProfitLogInReward(address,uint256,uint256,uint256)");
const profitsNotCollected = web3.utils.keccak256("ProfitsNotCollected(bool,bool)");

// code for a broken Aero contract: every call reverts with 0xdeadbeef
// (PUSH4 0xdeadbeef, PUSH1 0xe0, SHL, PUSH1 0, MSTORE, PUSH1 4, PUSH1 0, REVERT)
const revertingCode = "0x63deadbeef60e01b60005260046000fd";
// the same with Aero's own gas check error, InsufficientGasForCall() (0xe28a638c), as the revert data
const insufficientGasCode = "0x63e28a638c60e01b60005260046000fd";
// every call reverts without revert data (PUSH1 0, PUSH1 0, REVERT), and does not burn its gas
const emptyRevertCode = "0x60006000fd";
// every call hits INVALID: it burns all the gas it was given, and returns no revert data
const invalidCode = "0xfe";
const insufficientGasError = web3.eth.abi.encodeFunctionSignature("InsufficientGasForCall()"); // 0xe28a638c

// code for a LeafVoter that lets the first settleGauge of a transaction through and fails every later one with
// 0xdeadbeef. Every gauge claim, deposit and withdraw settles the gauge with the LeafVoter first (V2Gauge._advanceRewards),
// so in a hard work the claim goes through and the gauge deposit or withdraw after it fails. Any other call, and the first
// settleGauge, runs the LeafVoter's own code, copied to `copy`, through DELEGATECALL; a transient-storage flag remembers
// the first settleGauge until the end of the transaction
function laterSettleRevertsCode(copy) {
  let settleGauge = web3.eth.abi.encodeFunctionSignature("settleGauge(address)").slice(2);
  let flag = web3.utils.keccak256("harvest.test.settleGaugeCalls").slice(2);
  return "0x"
    + "600035" + "60e01c" + "63" + settleGauge + "14" + "610048" + "57" // selector == settleGauge: jump to 0x48
    + "5b" + "36" + "6000" + "6000" + "37" // 0x10: calldatacopy(0, 0, calldatasize)
    + "6000" + "6000" + "36" + "6000" + "73" + copy.slice(2).toLowerCase() + "5a" + "f4" // delegatecall(gas, copy, ...)
    + "3d60006000" + "3e" + "610043" + "57" + "3d6000fd" // returndatacopy; revert with it on failure ...
    + "5b" + "3d6000f3" // 0x43: ... else return it
    + "5b" + "7f" + flag + "5c" + "610097" + "57" // 0x48: settleGauge: a later one (flag set) jumps to 0x97
    + "6001" + "7f" + flag + "5d" + "610010" + "56" // the first one sets the flag and delegates (0x10)
    + "5b" + "63deadbeef60e01b60005260046000fd"; // 0x97: revert with 0xdeadbeef
}

// code for a pool whose mint fails with 0xdeadbeef, or as `failure` does (code such as emptyRevertCode, which runs from
// the mint's JUMPDEST at 0x48, the end of this code, so it moves no offset). In a hard work only the strategy's compounding
// mints LP (the AERO sale only swaps through the pools), so this fails the compounding alone. Any other call runs the
// pool's own code, copied to `copy`, through DELEGATECALL, in the pool's own storage
function mintRevertsCode(copy, failure = revertingCode) {
  let mint = web3.eth.abi.encodeFunctionSignature("mint(address)").slice(2);
  return "0x"
    + "600035" + "60e01c" + "63" + mint + "14" + "610048" + "57" // selector == mint: jump to 0x48
    + "5b" + "36" + "6000" + "6000" + "37" // 0x10: calldatacopy(0, 0, calldatasize)
    + "6000" + "6000" + "36" + "6000" + "73" + copy.slice(2).toLowerCase() + "5a" + "f4" // delegatecall(gas, copy, ...)
    + "3d60006000" + "3e" + "610043" + "57" + "3d6000fd" // returndatacopy; revert with it on failure ...
    + "5b" + "3d6000f3" // 0x43: ... else return it
    + "5b" + failure.slice(2); // 0x48: mint: revert (by default with 0xdeadbeef)
}

// Developed and tested at blockNumber 53206000

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet AerodromeV2 Stable USDC-alUSDb", function() {
  let accounts;

  // external contracts
  let underlying;
  let pool;
  let aeroToken;
  let usdcToken;
  let alusdbToken;
  let wethToken;
  let gauge;
  let gaugeFactory;
  let gaugeFactoryGovernance;
  let gaugeDepositFor;
  let leafVoter;
  let leafVoterEvents;
  let poolFeeAccounting;
  let poolSwaps;
  let poolFactory;
  let poolFactoryTape;
  let universalLiquidatorRegistry;

  // external setup
  let underlyingWhale = "0xEcC0975B80A65668459Fe838497bb1E57d0b3785"; // its LP is staked in the gauge
  let gaugeAddress = "0xBd18BdD2C99cE1C8FaB955451b035CAa03184d75";
  let leafVoterAddress = "0x382409fad8503FbCdbB27A4211551fa03e884078"; // the voter of the stable gauges too
  let aero = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let alusdb = "0x877014E21c32feA108B6A1f45f367efc9a2d9B9F";
  let weth = "0x4200000000000000000000000000000000000006";
  let volatilePoolFactory = "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2";
  let stablePoolFactory = "0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D";
  let volatilePoolAddress = "0xF634058dC94e6BF8e828E27621320C423bC8B18E"; // vAMMV2-AERO/USDC, for the pool-type check
  let volatileGaugeAddress = "0xd424BA8ca9d4E278753DE76651a0095451e65cD1";
  let otherGaugeAddress = "0xe932a09566A17d0d3EAbeE0C47544c6488Ea7fBe"; // gauge of another stable pool: sAMMV2-WETH/msETH
  let otherGaugeFactoryAddress = "0x9FBCf2Df0DC553ce40Ef63963Bff465b76792B7E"; // the volatile gauges' factory
  let gaugeManagerAddress = "0xbF234b32c5e58868243A4a14831626f3EdE7b183"; // Aero GaugeManager: the only caller of createGauge
  let aeroV2Dex = "0x6141Cacd5C7752ab0813347Ef87179e46c1c35Fc"; // UniversalLiquidator dex for Aero basic pools (registry key "aero")
  let zeroAddress = "0x0000000000000000000000000000000000000000";
  let leafVoterCopy = "0x00000000000000000000000000000000c0de1eaf"; // no code at the fork: holds a copy of the LeafVoter's code
  let poolCopy = "0x00000000000000000000000000000000c0de9001"; // no code at the fork: holds a copy of the pool's code
  let secondGaugeAddress; // the pool's second gauge, deployed by the test that moves the stake to it
  // Stable gauges have their own gauge factory (0x1e0f776E...7800, not the volatile one's); at this block the same Aero
  // Safes hold the roles we need on it (RoleGranted/RoleRevoked logs, confirmed with hasRole)
  let penaltyAdmin = "0x42255e3C2d0b71a0b006243148fdF1a71d054cE0"; // Aero Safe: PENALTY_ADMIN_ROLE, CAP_ADMIN_ROLE, GAUGE_TAPE_MANAGER_ROLE, LeafVoter CHAIN_STATUS_ROLE
  let emergencyWithdrawAdmin = "0x15ad691083b3d31ee0ad8664e606febd62cd8892"; // Aero Safe: EMERGENCY_WITHDRAW_ROLE
  let vaultImplementation = "0xC85B44eC8804421F23C0e34f42D054959061B803"; // what MegaFactory deploys
  // Keepers must stay below the lowest Aero MEV-tax threshold on the swap route: 1 gwei, because AERO is sold through the
  // volatile AERO/USDC pool (stable pools only tax above 2 gwei); hardhat's 2.5 gwei default would tax our swaps
  let keeperGasPrice = "100000000";

  // parties in the protocol
  let governance;
  let farmer1;
  let farmer2;
  let outsider; // holds LP, but no vault shares: stakes for the strategy behind its back

  // numbers used in tests
  let farmerBalance;
  let farmer2Balance;
  let lastClaimAmount;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0xA5e16dC9A5cae37563116D9407D8C73927675674");
    console.log("Fetching Underlying at: ", underlying.address);
    pool = await IAeroV2Pool.at(underlying.address);
    aeroToken = await IERC20.at(aero);
    usdcToken = await IERC20.at(usdc);
    alusdbToken = await IERC20.at(alusdb);
    wethToken = await IERC20.at(weth);
    gauge = await IAeroV2Gauge.at(gaugeAddress);
    gaugeFactory = await IAeroV2GaugeFactory.at(await gauge.gaugeFactory());
    gaugeFactoryGovernance = new web3.eth.Contract(gaugeFactoryGovernanceAbi, gaugeFactory.address);
    gaugeDepositFor = new web3.eth.Contract(gaugeDepositForAbi, gaugeAddress);
    leafVoter = await IAeroV2LeafVoter.at(leafVoterAddress);
    leafVoterEvents = new web3.eth.Contract(leafVoterEventsAbi, leafVoterAddress);
    poolFeeAccounting = new web3.eth.Contract(poolFeeAccountingAbi, underlying.address);
    poolSwaps = new web3.eth.Contract(poolSwapAbi, underlying.address);
    poolFactory = await IAeroV2PoolFactory.at(await pool.factory());
    assert.equal(poolFactory.address.toLowerCase(), stablePoolFactory.toLowerCase());
    poolFactoryTape = new web3.eth.Contract(poolFactoryTapeAbi, poolFactory.address);
    universalLiquidatorRegistry = await IUniversalLiquidatorRegistry.at(addresses.UniversalLiquidatorRegistry);
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    // the whale's LP is staked in the gauge: unstake it first
    await gauge.withdraw(await gauge.balanceOf(underlyingWhale), { from: underlyingWhale });
    let whaleBalance = new BigNumber(await underlying.balanceOf(underlyingWhale));
    farmerBalance = whaleBalance.times(6).div(10).integerValue(BigNumber.ROUND_DOWN);
    farmer2Balance = whaleBalance.minus(farmerBalance);
    await underlying.transfer(farmer1, farmerBalance.toFixed(), { from: underlyingWhale });
    await underlying.transfer(farmer2, farmer2Balance.toFixed(), { from: underlyingWhale });
  }

  async function doHardWork() {
    let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice });
    return tx.receipt.blockNumber;
  }

  // events the gauge emitted for the strategy in `block`
  async function gaugeEvents(name, block) {
    return await gauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
  }

  async function strategyEvents(name, block) {
    return await strategy.getPastEvents(name, { fromBlock: block, toBlock: block });
  }

  async function advanceToBlock(block) {
    let current = await web3.eth.getBlockNumber();
    if (block > current) {
      await Utils.advanceNBlock(block - current);
    }
  }

  // mines `n` blocks at once, 2 s apart as at the fork block: Utils.advanceNBlock mines block by block, far too slowly for
  // the 432,000 blocks of minStakeInterval
  async function mineBlocks(n) {
    await hre.network.provider.send("hardhat_mine", ["0x" + n.toString(16), "0x2"]);
  }

  // like advanceToBlock, for long walks
  async function mineToBlock(block) {
    let current = await web3.eth.getBlockNumber();
    if (block > current) {
      await mineBlocks(block - current);
    }
  }

  // setMinStakeBlocks(gauge, 0) does not remove the window: it falls back to the factory default
  async function assertNoWindow() {
    let config = await gaugeFactory.effectivePenaltyConfig(gaugeAddress);
    assert.equal(config.minStakeBlocks.toString(), "0", "no window expected: a gauge set to 0 uses the factory default, which must be 0");
  }

  // sends a transaction that must revert and returns hardhat's error message
  async function revertMessage(txPromise, failMessage) {
    try {
      await txPromise;
    } catch (e) {
      return e.message;
    }
    assert.fail(failMessage);
  }

  // the part of hardhat's revert message that carries these exact revert data (it cannot decode Aero's errors by name)
  function revertData(data) {
    return "(return data: " + data + ")";
  }

  // a part of farmer2's LP, for deposits
  async function farmer2LP(divisor) {
    return new BigNumber(await underlying.balanceOf(farmer2)).div(divisor).integerValue(BigNumber.ROUND_DOWN).toFixed();
  }

  // the first block where the strategy may stake again: minStakeInterval blocks after its own last stake and, while Aero
  // enforces a window, also stakeSpacing windows after the gauge's depositBlock; 0 with nothing of its own staked
  async function nextStakeBlock() {
    let lastStake = Number((await strategy.lastStakeBlock()).toString());
    if (lastStake == 0) {
      return 0;
    }
    let next = lastStake + Number((await strategy.minStakeInterval()).toString());
    let window = await strategy.penaltyWindow();
    if (window.minStakeBlocks.toString() != "0" && window.penaltyRate.toString() != "0") {
      next = Math.max(next, Number((await gauge.depositBlock(strategy.address)).toString())
        + Math.max(1, Number((await strategy.stakeSpacing()).toString())) * Number(window.minStakeBlocks.toString()));
    }
    return next;
  }

  // past the window and the stakeSpacing of the last stake, farmer2 deposits `newLP` and the hard work claims, then stakes
  async function claimThenStake(newLP) {
    await advanceToBlock(await nextStakeBlock());
    await depositVault(farmer2, underlying, vault, newLP);
    let block = await doHardWork();
    assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim outside the window");
    assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
    return block;
  }

  // the strategy's reward checkpoint in the gauge, as of its last stake, claim or withdrawal
  async function gaugeCheckpoint() {
    return {
      balance: new BigNumber(await gauge.balanceOf(strategy.address)),
      paid: new BigNumber(await gauge.userRewardPerTokenPaid(strategy.address)),
      rewards: new BigNumber(await gauge.rewards(strategy.address)),
    };
  }

  // AERO the strategy's stake earned from `checkpoint` to its latest one: the stake times the growth of its reward
  // per token (V2Gauge._earned, without the rewards that `checkpoint` had already snapshotted)
  async function accruedSince(checkpoint) {
    let paid = new BigNumber(await gauge.userRewardPerTokenPaid(strategy.address));
    return checkpoint.balance.times(paid.minus(checkpoint.paid)).idiv(1e18);
  }

  // the LP the next hard work stakes, before new deposits: what waits in the vault and in the strategy
  async function unstakedLP() {
    return new BigNumber(await vault.underlyingBalanceInVault()).plus(await underlying.balanceOf(strategy.address));
  }

  // LP waiting in the strategy for its next stake still counts in the strategy's value, and so in the vault's
  async function assertIdleLPCounted() {
    let staked = new BigNumber(await gauge.balanceOf(strategy.address));
    let idle = new BigNumber(await underlying.balanceOf(strategy.address));
    Utils.assertBNGt(idle, 0);
    Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked.plus(idle));
    Utils.assertBNEq(await vault.underlyingBalanceWithInvestment(), staked.plus(idle).plus(await vault.underlyingBalanceInVault()));
  }

  // the pool's fee payouts to the strategy in `block`
  async function feeClaims(block) {
    return await poolFeeAccounting.getPastEvents("Claim", { filter: { account: strategy.address }, fromBlock: block, toBlock: block });
  }

  // the pool fees the strategy is owed: it earns them on the LP it holds unstaked
  async function pendingFees() {
    let pending = await poolFeeAccounting.methods.pendingFees(strategy.address).call();
    return { amount0: pending.amount0, amount1: pending.amount1 };
  }

  // farmer2 wraps `amount` of ETH and sends the WETH to the strategy (a token it does not farm)
  async function sendWETH(amount) {
    await (await IWETH.at(weth)).deposit({ from: farmer2, value: amount });
    await wethToken.transfer(strategy.address, amount, { from: farmer2 });
  }

  // the pool's `name` events (Swap, Mint, Fees) in `block` sent by `sender`: by the strategy itself for its zap
  async function poolEvents(name, block, sender) {
    return await poolSwaps.getPastEvents(name, { filter: { sender: sender }, fromBlock: block, toBlock: block });
  }

  // LP the pool minted to the strategy in `block`
  async function mintedLP(block) {
    let mints = await underlying.getPastEvents("Transfer", { filter: { from: zeroAddress, to: strategy.address }, fromBlock: block, toBlock: block });
    return mints.reduce((total, mint) => total.plus(mint.args.value.toString()), new BigNumber(0));
  }

  // value in dollars (18 decimals) of amounts of the pool tokens: both ~$1, USDC with 6 decimals
  async function dollars(amount0, amount1) {
    return new BigNumber(amount0).times(1e12).plus(amount1);
  }

  // dollars of the pool tokens the strategy holds, outside the LP
  async function poolTokensHeld() {
    return await dollars(await usdcToken.balanceOf(strategy.address), await alusdbToken.balanceOf(strategy.address));
  }

  // dollars behind `lp` LP at the pool's reserves
  async function lpDollars(lp) {
    let reserves = await pool.getReserves();
    return new BigNumber(lp).times(await dollars(reserves[0].toString(), reserves[1].toString())).idiv(await pool.totalSupply());
  }

  // the reward sale of the hard work in `block`: the AERO it took the fee on (its one ProfitLogInReward), the fee (its one
  // AERO transfer to the reward forwarder), and the AERO it sold (its other AERO transfers, to the liquidator's dex: a
  // share for each pool token, neither being AERO), next to what the fee left of the fee base, which it should all sell
  async function rewardSale(block) {
    let profits = await strategyEvents(profitLogInReward, block);
    assert.equal(profits.length, 1, "should take the fee once");
    let feeBase = new BigNumber(profits[0].args.profitAmount.toString());
    let forwarder = (await controller.rewardForwarder()).toLowerCase();
    let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
    let fees = aeroOut.filter(transfer => transfer.args.to.toLowerCase() == forwarder);
    assert.equal(fees.length, 1, "the fee should go to the reward forwarder");
    let fee = new BigNumber(fees[0].args.value.toString());
    let sales = aeroOut.filter(transfer => transfer.args.to.toLowerCase() != forwarder);
    assert.equal(sales.length, 2, "the sales of the USDC and the alUSDb shares should go through the liquidator");
    return { feeBase: feeBase, fee: fee, split: feeBase.minus(fee),
      sold: sales.reduce((total, sale) => total.plus(sale.args.value.toString()), new BigNumber(0)) };
  }

  // farmer2 burns a part of its LP (1/`divisor`) for the pool tokens behind it; returns what it got [USDC, alUSDb]
  async function burnLP(divisor) {
    let before = [new BigNumber(await usdcToken.balanceOf(farmer2)), new BigNumber(await alusdbToken.balanceOf(farmer2))];
    await underlying.transfer(underlying.address, await farmer2LP(divisor), { from: farmer2 });
    await poolSwaps.methods.burn(farmer2).send({ from: farmer2, gas: 1000000 });
    return [new BigNumber(await usdcToken.balanceOf(farmer2)).minus(before[0]),
      new BigNumber(await alusdbToken.balanceOf(farmer2)).minus(before[1])];
  }

  // `from` swaps `amountIn` of `tokenIn` through the pool itself, below the MEV-tax threshold
  async function poolSwap(from, tokenIn, amountIn) {
    let amountOut = (await pool.getAmountOutWithTotalFee(amountIn, tokenIn, { from: from })).toString();
    await (await IERC20.at(tokenIn)).transfer(underlying.address, amountIn, { from: from });
    if (tokenIn.toLowerCase() == (await pool.token0()).toLowerCase()) {
      await pool.swap(0, amountOut, from, "0x", { from: from, gasPrice: keeperGasPrice });
    } else {
      await pool.swap(amountOut, 0, from, "0x", { from: from, gasPrice: keeperGasPrice });
    }
    return amountOut;
  }

  // the outsider stakes `amount` of LP (from farmer1) for the strategy, which V2Gauge.depositFor allows while Aero
  // enforces no window
  async function outsiderDepositFor(amount) {
    await underlying.transfer(outsider, amount, { from: farmer1 });
    await underlying.approve(gaugeAddress, amount, { from: outsider });
    return await gaugeDepositFor.methods.depositFor(amount, strategy.address).send({ from: outsider, gas: 1000000 });
  }

  // the gas a best-effort gauge exit (emergencyExit, and the hard work's exit from a gauge Aero switched off or while
  // keepUnstaked is on) must have left when it starts: gaugeTapeGasLimit + 1,000,000 for the gauge withdraw, + 200,000
  // kept back for the emergencyWithdraw fallback
  async function exitGasFloor() {
    return Number((await gaugeFactory.gaugeTapeGasLimit()).toString()) + 1200000;
  }

  // the least gas limit, to within 1,000, with which the transaction `call` goes through, simulated with eth_call (nothing
  // changes) on the current state. eth_estimateGas cannot be used for this: its search starts above the per-transaction
  // gas cap
  async function leastGas(call, low, high) {
    while (high - low > 1000) {
      let mid = Math.floor((low + high) / 2);
      try {
        await web3.eth.call(Object.assign({}, call, { gas: mid }));
        high = mid;
      } catch (e) {
        low = mid;
      }
    }
    return high;
  }

  // Aero switches the gauge off (cap 0) or back on, here as its cap admin (the LeafVoter's emergency council can switch it
  // off too). Only its cap admin can switch it back on; the cap operator can neither set a 0 cap nor raise one
  // (CapOutOfOperatorRange, NotAuthorized). Setting the cap also settles the gauge and flushes its fees to the voters
  async function setEmissionCap(cap) {
    await gaugeFactoryGovernance.methods.setEmissionCap(gaugeAddress, cap).send({ from: penaltyAdmin });
  }

  // runs `fn` while the LeafVoter runs `code` instead of its own, which comes back afterwards
  async function withLeafVoterCode(code, fn) {
    let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
    await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, code]);
    try {
      return await fn();
    } finally {
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
    }
  }

  // runs `fn` while, in each transaction, the first gauge claim, deposit or withdraw works and every later one fails with
  // 0xdeadbeef (laterSettleRevertsCode)
  async function withGaugeFailingAfterClaim(fn) {
    await hre.network.provider.send("hardhat_setCode", [leafVoterCopy, await web3.eth.getCode(leafVoterAddress)]);
    try {
      return await withLeafVoterCode(laterSettleRevertsCode(leafVoterCopy), fn);
    } finally {
      await hre.network.provider.send("hardhat_setCode", [leafVoterCopy, "0x"]);
    }
  }

  // runs `fn` while every mint of the pool fails with 0xdeadbeef, or as the code `failure` does (mintRevertsCode), and the
  // pool's own code comes back afterwards
  async function withPoolMintFailing(fn, failure = revertingCode) {
    let poolCode = await web3.eth.getCode(underlying.address);
    assert.equal(await web3.eth.getCode(poolCopy), "0x", "the copy should go to an address without code");
    await hre.network.provider.send("hardhat_setCode", [poolCopy, poolCode]);
    try {
      await hre.network.provider.send("hardhat_setCode", [underlying.address, mintRevertsCode(poolCopy, failure)]);
      try {
        return await fn();
      } finally {
        await hre.network.provider.send("hardhat_setCode", [underlying.address, poolCode]);
      }
    } finally {
      await hre.network.provider.send("hardhat_setCode", [poolCopy, "0x"]);
    }
  }

  // runs `fn` while every swap through the pools of `factoryAddress` fails Aero's gas check (InsufficientGasForCall), as
  // if the transaction had run short of gas there: the factory's pool tape manager raises poolTapeGasLimit above any
  // transaction's gas
  async function withPoolTapeFailing(factoryAddress, fn) {
    let factory = new web3.eth.Contract(poolFactoryTapeAbi, factoryAddress);
    let poolTape = await factory.methods.poolTape().call();
    let poolTapeGasLimit = await factory.methods.poolTapeGasLimit().call();
    let manager = await factory.methods.poolTapeManager().call();
    assert.notEqual(poolTape, zeroAddress, "the gas check only runs with a pool tape");
    let managerEth = await web3.eth.getBalance(manager);
    await impersonates([manager]);
    await hre.network.provider.send("hardhat_setBalance", [manager, "0x8AC7230489E80000"]); // gas for its calls
    try {
      await factory.methods.setPoolTape(poolTape, "4000000000").send({ from: manager });
      try {
        return await fn();
      } finally {
        await factory.methods.setPoolTape(poolTape, poolTapeGasLimit).send({ from: manager });
      }
    } finally {
      await hre.network.provider.send("hardhat_setBalance", [manager, web3.utils.toHex(managerEth)]);
      if (manager.toLowerCase() != penaltyAdmin.toLowerCase()) {
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [manager] });
      }
    }
  }

  // runs `fn` while Aero's pauser has paused swaps in all pools of the pool's factory (Pool.swap reverts IsPaused; mint
  // and burn still work)
  async function withSwapsPaused(fn) {
    let pauser = await poolFactory.pauser();
    assert.equal(pauser.toLowerCase(), penaltyAdmin.toLowerCase(), "the pool factory's pauser is the Aero Safe impersonated above");
    await poolFactory.setPauseState(true, { from: pauser });
    try {
      assert.equal(await poolFactory.isPaused(), true);
      return await fn();
    } finally {
      await poolFactory.setPauseState(false, { from: pauser });
    }
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];
    farmer2 = accounts[2];
    outsider = accounts[3];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, addresses.ULOwner, penaltyAdmin, emergencyWithdrawAdmin]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: addresses.ULOwner, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: penaltyAdmin, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: emergencyWithdrawAdmin, value: 10e18});

    await setupExternalContracts();
    await assertNoWindow(); // the happy path and "User deposits" stake without a window
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
      "vaultImplementationOverride": vaultImplementation,
      "strategyArtifact": Strategy,
      "strategyArtifactIsUpgradable": true,
      "underlying": underlying,
      "governance": governance,
      "aeroV2Setup": [
        [aero, usdc, volatilePoolFactory],
        [usdc, alusdb, stablePoolFactory],
      ],
      "liquidation": [
        {"aero": [aero, usdc]},
        {"aero": [usdc, alusdb]},
      ],
      "ULOwner": addresses.ULOwner,
    });

    // truffle-contract polls for 24 confirmations after every transaction (handlers.js offers this switch for tests):
    // over the long block-by-block simulations below hundreds of these pollers pile up and stall the in-process node
    for (let truffleContract of [IERC20, IAeroV2Dex, IAeroV2Gauge, IAeroV2GaugeFactory, IAeroV2LeafVoter, IAeroV2Pool,
      IAeroV2PoolFactory, IUniversalLiquidator, IUniversalLiquidatorRegistry, IWETH, StrategyProxy, StableStrategy,
      controller.constructor, vault.constructor, strategy.constructor]) {
      truffleContract.disableConfirmationListener = true;
    }

    // user deposits must wait in the vault until the keeper's hard work (new vaults start with investOnDeposit = true)
    await vault.setInvestOnDeposit(false, { from: governance });

    // a new strategy has never staked, and stakes at most once per minStakeInterval (about a day of 0.2 s blocks)
    assert.equal((await strategy.minStakeInterval()).toString(), "432000", "the default minStakeInterval");
    assert.equal((await strategy.lastStakeBlock()).toString(), "0", "a new strategy has never staked");
    assert.equal(await strategy.keepUnstaked(), false, "a new strategy stakes its LP: governance has not kept it unstaked");
    assert.equal((await strategy.feePaidReward()).toString(), "0", "a new strategy holds no AERO whose fee was taken");
    // most describes test the window logic on its own; the "Minimum stake interval" describe restores the default and
    // tests the interval
    await strategy.setMinStakeInterval(0, { from: governance });

    // whale send underlying to farmers
    await setupBalance();
  });

  describe("Happy path", function() {
    it("Farmer should earn money", async function() {
      let farmerOldBalance = new BigNumber(await underlying.balanceOf(farmer1));
      await depositVault(farmer1, underlying, vault, farmerBalance);

      let hours = 10;
      let blocksPerHour = 3600;
      let oldSharePrice;
      let newSharePrice;

      for (let i = 0; i < hours; i++) {
        console.log("loop ", i);

        // every hard work stakes all it compounded: minStakeInterval is 0 here (root before())
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        let block = await doHardWork();
        newSharePrice = new BigNumber(await vault.getPricePerFullShare());

        console.log("old shareprice: ", oldSharePrice.toFixed());
        console.log("new shareprice: ", newSharePrice.toFixed());
        console.log("growth: ", newSharePrice.toFixed() / oldSharePrice.toFixed());

        apr = (newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))*365;
        apy = ((newSharePrice.toFixed()/oldSharePrice.toFixed()-1)*(24/(blocksPerHour/1800))+1)**365;

        console.log("instant APR:", apr*100, "%");
        console.log("instant APY:", (apy-1)*100, "%");

        if (i > 0) {
          // the rewards go into the stable pool in its own ratio: almost nothing is left over (both tokens ~$1)
          let reserves = await pool.getReserves();
          let reserve0 = new BigNumber(reserves[0].toString());
          let reserve1 = new BigNumber(reserves[1].toString());
          let minted = new BigNumber(await gauge.balanceOf(strategy.address)).minus(stakedBefore);
          let mintedValue = minted.times(reserve0.times(1e12).plus(reserve1)).idiv(await pool.totalSupply());
          let leftover = new BigNumber(await usdcToken.balanceOf(strategy.address)).times(1e12)
            .plus(await alusdbToken.balanceOf(strategy.address));
          console.log("compounded ($, 18 decimals): ", mintedValue.toFixed(), " left over: ", leftover.toFixed());
          Utils.assertBNGt(minted, 0);
          Utils.assertBNGt(mintedValue, leftover.times(50)); // leftover below 2%

          // the reward split already lands on the pool's ratio, so the zap's own swap through the pool only evens out what
          // the split misses (the shift of the reserves by the sale's USDC -> alUSDb leg, which goes through this pool; the
          // split's two probes cancel their own price impact): about a millionth of the compounded value here, ~2.7e-6 with
          // a single probe. The zap would quietly repair a split that under-allocates a side, at a swap fee, which the
          // leftover check above cannot see: 10% less USDC in the split sends ~4% of the value through the zap. A tenth of
          // a percent is far from both
          let zapSwaps = await poolEvents("Swap", block, strategy.address);
          assert.isAtMost(zapSwaps.length, 1);
          let zapped = zapSwaps.length == 0 ? new BigNumber(0)
            : await dollars(zapSwaps[0].returnValues.amount0In, zapSwaps[0].returnValues.amount1In);
          console.log("zapped ($, 18 decimals): ", zapped.toFixed(), " share of the compounded value: ", zapped.toNumber() / mintedValue.toNumber());
          Utils.assertBNGt(mintedValue, zapped.times(1000)); // the zap swapped less than 0.1% of what was compounded
        }

        await Utils.advanceNBlock(blocksPerHour);
      }
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      Utils.assertBNGt(farmerNewBalance, farmerOldBalance);

      apr = (farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))*365;
      apy = ((farmerNewBalance.toFixed()/farmerOldBalance.toFixed()-1)*(24/(blocksPerHour*hours/1800))+1)**365;

      console.log("earned!");
      console.log("APR:", apr*100, "%");
      console.log("APY:", (apy-1)*100, "%");

      await strategy.withdrawAllToVault({from:governance}); // making sure can withdraw all for a next switch

    });
  });

  describe("User deposits and withdrawals", function() {
    // the strategy's error for a hard work that the vault runs while it runs hard works for users
    let flagsOn = "investOnDeposit or compoundOnWithdraw is on";

    // what a user deposit or withdrawal that reverts must leave as it was: the user's LP and shares, the vault, the
    // strategy and its stake
    async function userState(user) {
      return {
        userLP: (await underlying.balanceOf(user)).toString(),
        userShares: (await vault.balanceOf(user)).toString(),
        totalShares: (await vault.totalSupply()).toString(),
        vaultLP: (await vault.underlyingBalanceInVault()).toString(),
        strategyLP: (await underlying.balanceOf(strategy.address)).toString(),
        strategyAero: (await aeroToken.balanceOf(strategy.address)).toString(),
        staked: (await gauge.balanceOf(strategy.address)).toString(),
        rewardPerTokenPaid: (await gauge.userRewardPerTokenPaid(strategy.address)).toString(), // nothing claimed
        depositBlock: (await gauge.depositBlock(strategy.address)).toString(),
        lastStakeBlock: (await strategy.lastStakeBlock()).toString(),
      };
    }

    // governance calls the strategy's doHardWork itself, not through the vault: with AERO to claim (and minStakeInterval 0,
    // root before()) it claims, sells, compounds and stakes what it compounded
    async function governanceHardWork() {
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      let tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
      let block = tx.receipt.blockNumber;
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "governance's own hard work should claim");
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "governance's own hard work should sell the AERO");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "governance's own hard work should stake");
      Utils.assertBNEq(deposits[0].args._amount.toString(), idle.plus(minted));
      return block;
    }

    it("Never reach the gauge: a user deposit reverts while investOnDeposit is on, and so does the keeper's hard work through the vault, while governance's own runs and user withdrawals go through", async function() {
      // a stake for the hard works below to claim from: half of farmer1's LP, deposited with the flag off (root before())
      // and staked by the keeper
      let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(2).integerValue(BigNumber.ROUND_DOWN);
      await depositVault(farmer1, underlying, vault, amount.toFixed());
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "keeper hard work should stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      await mineBlocks(600); // AERO to claim

      // the vault default: user deposits run the strategy's doHardWork, where each deposit would restart the penalty
      // window. The strategy refuses it, so a user deposit reverts as a whole and changes nothing
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        let deposit = amount.div(10).integerValue(BigNumber.ROUND_DOWN).toFixed();
        await underlying.approve(vault.address, deposit, { from: farmer1 });
        let before = await userState(farmer1);
        let message = await revertMessage(vault.deposit(deposit, farmer1, { from: farmer1 }), "a user deposit should revert while investOnDeposit is on");
        assert.include(message, flagsOn);
        assert.deepEqual(await userState(farmer1), before, "a user deposit that reverts should change nothing");

        // the keeper also comes through the vault, so its hard work reverts too, loudly instead of silently compounding
        // nothing while the flag is on: the flag must be turned off at deployment
        message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "the keeper's hard work through the vault should revert while investOnDeposit is on");
        assert.include(message, flagsOn);
        assert.deepEqual(await userState(farmer1), before, "a keeper hard work that reverts should change nothing");

        // governance calling the strategy itself is not the vault: its hard work runs
        await governanceHardWork();

        // and users can still leave: a withdrawal runs no hard work while only investOnDeposit is on (compoundOnWithdraw
        // would run one), so it is paid in full, here from the gauge, which holds all the LP
        assert.equal(await vault.investOnDeposit(), true);
        assert.equal(await vault.compoundOnWithdraw(), false);
        Utils.assertBNEq(await unstakedLP(), 0);
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
        let sharesBefore = new BigNumber(await vault.balanceOf(farmer1));
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        let withdrawal = tx.receipt.blockNumber;
        Utils.assertBNGt(expected, 0);
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
        Utils.assertBNEq(sharesBefore.minus(await vault.balanceOf(farmer1)), shares);
        let withdrawn = await gaugeEvents("Withdraw", withdrawal);
        assert.equal(withdrawn.length, 1, "the withdrawal should be paid from the gauge");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected);
        // nothing is staked, sold or compounded in it. The gauge's withdraw pays out the AERO the stake earned
        // (EmissionsClaimed), which waits in the strategy, unsold, for the next hard work
        assert.equal((await gaugeEvents("Deposit", withdrawal)).length, 0, "a user withdrawal should not stake");
        assert.equal((await strategyEvents(profitLogInReward, withdrawal)).length, 0, "a user withdrawal should not sell");
        assert.equal((await poolEvents("Mint", withdrawal, strategy.address)).length, 0, "a user withdrawal should not compound");
        let paid = (await gaugeEvents("EmissionsClaimed", withdrawal))
          .reduce((total, claim) => total.plus(claim.args._rewardAmount.toString()), new BigNumber(0));
        console.log("user withdrawal while investOnDeposit is on: LP ", expected.toFixed(), " AERO the gauge paid out with it: ", paid.toFixed());
        Utils.assertBNGt(paid, 0);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(paid));
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }

      // with the flag off, the keeper's hard work through the vault runs again
      block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "keeper hard work should claim");
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "keeper hard work should stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Never reach the gauge: a user withdrawal reverts while compoundOnWithdraw is on, and goes through once governance turns it off", async function() {
      // with compoundOnWithdraw on, every user withdrawal runs the strategy's doHardWork
      await vault.setCompoundOnWithdraw(true, { from: governance });
      let shares;
      try {
        assert.equal(await vault.compoundOnWithdraw(), true);
        assert.equal(await vault.investOnDeposit(), false, "only compoundOnWithdraw should call for the revert");

        // a deposit (no hard work with investOnDeposit off) waits in the vault, and a smaller withdrawal would be paid from
        // it: only the hard work inside it could reach the gauge. The strategy refuses that hard work, so the withdrawal
        // reverts as a whole and changes nothing: withdrawals fail closed until governance turns the flag off
        let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, amount.toFixed());
        shares = amount.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
        let before = await userState(farmer1);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "a user withdrawal should revert while compoundOnWithdraw is on");
        assert.include(message, flagsOn);
        assert.deepEqual(await userState(farmer1), before, "a user withdrawal that reverts should change nothing");

        // so does the keeper's hard work through the vault
        message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "the keeper's hard work through the vault should revert while compoundOnWithdraw is on");
        assert.include(message, flagsOn);
        assert.deepEqual(await userState(farmer1), before, "a keeper hard work that reverts should change nothing");

        // while governance's own hard work runs; the deposit still waits in the vault, which only its own hard work invests
        await mineBlocks(600); // AERO to claim
        await governanceHardWork();
        Utils.assertBNEq(await vault.underlyingBalanceInVault(), before.vaultLP);
      } finally {
        await vault.setCompoundOnWithdraw(false, { from: governance });
      }

      // with the flag off, the same withdrawal goes through, paid from the vault: nothing reaches the gauge
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let sharesBefore = new BigNumber(await vault.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
      Utils.assertBNEq(sharesBefore.minus(await vault.balanceOf(farmer1)), shares);
      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the withdrawal should be paid from the vault");
      assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "user withdrawal should not claim");
      assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user withdrawal should not reach the gauge");
    });

    it("Never reach the gauge with both flags on: a user deposit, a user withdrawal and the keeper's hard work through the vault all revert, while governance's own runs go through", async function() {
      // each flag alone makes every hard work the vault runs revert (the tests above), and both together must too: a check
      // in which the two flags cancel out would let user deposits and withdrawals run the hard work into the gauge. A
      // deposit with both flags off waits in the vault, so that a smaller withdrawal would be paid from it
      let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
      await depositVault(farmer1, underlying, vault, amount.toFixed());
      await mineBlocks(600); // AERO to claim
      let shares = amount.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        await vault.setCompoundOnWithdraw(true, { from: governance });
        try {
          assert.equal(await vault.investOnDeposit(), true);
          assert.equal(await vault.compoundOnWithdraw(), true);
          let deposit = amount.div(10).integerValue(BigNumber.ROUND_DOWN).toFixed();
          await underlying.approve(vault.address, deposit, { from: farmer1 });
          let before = await userState(farmer1);

          // a user deposit runs the strategy's doHardWork (investOnDeposit): the strategy refuses it, so the deposit reverts
          // as a whole and changes nothing
          let message = await revertMessage(vault.deposit(deposit, farmer1, { from: farmer1 }), "a user deposit should revert while both flags are on");
          assert.include(message, flagsOn);
          assert.deepEqual(await userState(farmer1), before, "a user deposit that reverts should change nothing");

          // so does a user withdrawal (compoundOnWithdraw), which the LP waiting in the vault would pay: only the hard work
          // inside it could reach the gauge
          Utils.assertBNGt(before.vaultLP, new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply()));
          message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "a user withdrawal should revert while both flags are on");
          assert.include(message, flagsOn);
          assert.deepEqual(await userState(farmer1), before, "a user withdrawal that reverts should change nothing");

          // and the keeper's hard work through the vault
          message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
            "the keeper's hard work through the vault should revert while both flags are on");
          assert.include(message, flagsOn);
          assert.deepEqual(await userState(farmer1), before, "a keeper hard work that reverts should change nothing");

          // while governance's own hard work runs; the deposit still waits in the vault, which only its own hard work invests
          await governanceHardWork();
          Utils.assertBNEq(await vault.underlyingBalanceInVault(), before.vaultLP);
        } finally {
          await vault.setCompoundOnWithdraw(false, { from: governance });
        }
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }

      // with both flags off, the same withdrawal goes through, paid from the vault: nothing reaches the gauge
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the withdrawal should be paid from the vault");
      assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user withdrawal should not reach the gauge");
      // and the keeper's hard work runs again: it invests the LP waiting in the vault and stakes it
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "keeper hard work should stake");
      Utils.assertBNEq(await unstakedLP(), 0);
    });

    it("Hands all the LP to the vault through withdrawAll with both flags on: that path runs no hard work", async function() {
      // withdrawAll, which rebalance, setStrategy (migration) and the last share's withdrawal also use, runs no hard work,
      // so the vault's flags must not block it: a new vault starts with investOnDeposit on, and its strategy must still
      // be able to leave. The test runs on a snapshot that it reverts, so the tests after it see the chain as before
      let snapshot = await hre.network.provider.send("evm_snapshot", []);
      try {
        await vault.setInvestOnDeposit(true, { from: governance });
        await vault.setCompoundOnWithdraw(true, { from: governance });
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1, "withdrawAll should take the stake out while both flags are on");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      } finally {
        await hre.network.provider.send("evm_revert", [snapshot]);
      }
    });
  });

  describe("Minimum stake interval (no window)", function() {
    let interval;

    before(async function() {
      await assertNoWindow();
      // the default that initializeBaseStrategy sets (checked in the root before(), which then set 0)
      await strategy.setMinStakeInterval(432000, { from: governance });
      interval = Number((await strategy.minStakeInterval()).toString());
    });

    after(async function() {
      await strategy.setMinStakeInterval(0, { from: governance });
    });

    // farmer1 withdraws all the LP waiting in the vault and the strategy, and `fromGauge` more, which the strategy takes out
    // of the gauge; returns the block
    async function withdrawFromGauge(fromGauge) {
      let lp = (await unstakedLP()).plus(fromGauge);
      let value = new BigNumber(await vault.underlyingBalanceWithInvestment());
      let shares = lp.times(await vault.totalSupply()).plus(value).minus(1).idiv(value); // rounded up
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "the withdrawal should reach the gauge");
      Utils.assertBNGte(withdrawn[0].args._amount.toString(), fromGauge);
      Utils.assertBNGt(new BigNumber(fromGauge).plus(10), withdrawn[0].args._amount.toString()); // the vault's rounding
      return tx.receipt.blockNumber;
    }

    // what the gauge's LeafVoter took back from the gauge in `block`: forfeited penalties, emissions nobody could earn
    async function forfeited(block) {
      return await leafVoterEvents.getPastEvents("EmissionsForfeited", { filter: { _gauge: gaugeAddress }, fromBlock: block, toBlock: block });
    }

    // farmer1 deposits a tenth of its LP, which waits in the vault for the next hard work (the window describes below
    // deposit all of farmer2's LP, which is left untouched here)
    async function depositNewLP() {
      let lp = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN).toFixed();
      await depositVault(farmer1, underlying, vault, lp);
    }

    it("With nothing staked, stakes at once, and records the block of that stake as lastStakeBlock", async function() {
      // a full exit leaves nothing staked, and no last stake to count the interval from
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), "0", "a full exit should reset lastStakeBlock");
      let lpBefore = await unstakedLP();

      let block = await doHardWork();
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake at once");
      Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block), "should record the block of the stake");
      assert.equal(await nextStakeBlock(), block + interval);
    });

    it("Claims and compounds before lastStakeBlock + minStakeInterval, but keeps new LP idle until that block", async function() {
      let lastStake = Number((await strategy.lastStakeBlock()).toString());
      assert.equal(await nextStakeBlock(), lastStake + interval);

      // an hour later, with new LP: the hard work claims, sells and compounds the AERO, and keeps all the LP unstaked
      await depositNewLP();
      await mineBlocks(1800);
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let block = await doHardWork();
      assert.isBelow(block, lastStake + interval);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
      Utils.assertBNGt(await mintedLP(block), 0); // and compound it
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake within minStakeInterval of the last stake");
      let skipped = await strategyEvents("StakeSkipped", block);
      assert.equal(skipped.length, 1);
      Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
      // the waiting LP, new and compounded, keeps its full value for the vault's users
      await assertIdleLPCounted();
      Utils.assertBNGt(await vault.getPricePerFullShare(), sharePrice);

      // one block before the interval ends it still claims, compounds and waits ...
      await mineToBlock(lastStake + interval - 2);
      block = await doHardWork();
      assert.equal(block, lastStake + interval - 1);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      Utils.assertBNGt(await mintedLP(block), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(lastStake));
      await assertIdleLPCounted();

      // ... and the hard work at lastStakeBlock + minStakeInterval stakes all the idle LP
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      block = await doHardWork();
      assert.equal(block, lastStake + interval);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake once the interval is over");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
    });

    it("Keeps the stake out of a window that Aero switches on later, where staking on every hard work would leave all of it", async function() {
      // Aero's windows also cover stakes made before they were switched on: a window of 1800 blocks switched on now
      // catches any stake of the last 1800 blocks
      let windowBlocks = 1800;
      assert.equal(await gauge.isPenaltyActive(strategy.address), false);

      // with minStakeInterval 0 every hard work stakes, so the stake is always recent: a hard work with new LP, an hour
      // after the last one, stakes it
      await strategy.setMinStakeInterval(0, { from: governance });
      try {
        await depositNewLP();
        await mineBlocks(1800);
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake on every hard work");

        // shortly after, Aero switches on the window: the whole stake is inside it, and a user withdrawal of 1,000,000 wei
        // of LP from the gauge forfeits all the AERO it earned since the hard work's claim
        await mineBlocks(100);
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
        try {
          assert.equal(await gauge.isPenaltyActive(strategy.address), true, "the stake should be inside the new window");
          let before = await gaugeCheckpoint();
          let withdrawal = await withdrawFromGauge(1000000);
          let lost = (await accruedSince(before)).plus(before.rewards);
          let penalties = await gaugeEvents("EarlyWithdrawPenalty", withdrawal);
          assert.equal(penalties.length, 1, "should forfeit inside the window");
          Utils.assertBNEq(penalties[0].args._penalty.toString(), lost);
          let forfeits = await forfeited(withdrawal);
          assert.equal(forfeits.length, 1);
          Utils.assertBNEq(forfeits[0].returnValues._amount, lost);
          assert.equal((await gaugeEvents("EmissionsClaimed", withdrawal)).length, 0, "a 100% penalty should leave nothing to claim");
          console.log("AERO forfeited by a 1,000,000 wei withdrawal 100 blocks after a stake: ", lost.toFixed());
          Utils.assertBNGt(lost, 0);
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
      await assertNoWindow();

      // with the default interval the same hard work does not stake (the last stake was a little while ago) ...
      await depositNewLP();
      await mineBlocks(1800);
      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake within minStakeInterval of the last stake");

      // ... so the same window, switched on as shortly after, finds the stake outside it: the same withdrawal from the
      // gauge forfeits nothing, and pays the strategy what it earned
      await mineBlocks(100);
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
      try {
        assert.equal(await gauge.isPenaltyActive(strategy.address), false, "the stake should be older than the new window");
        let before = await gaugeCheckpoint();
        let withdrawal = await withdrawFromGauge(1000000);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", withdrawal)).length, 0, "nothing should be forfeited");
        assert.equal((await forfeited(withdrawal)).length, 0, "nothing should be forfeited");
        let claimed = await gaugeEvents("EmissionsClaimed", withdrawal);
        assert.equal(claimed.length, 1);
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Stakes at its own lastStakeBlock + minStakeInterval although an outsider restarts the gauge's depositBlock with depositFor", async function() {
      let lastStake = Number((await strategy.lastStakeBlock()).toString());
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);

      // with no window, an outsider stakes 1 wei of LP for the strategy: the gauge counts it in the strategy's stake and
      // restarts the strategy's depositBlock, which the strategy cannot prevent
      await mineBlocks(1800);
      let grief = await outsiderDepositFor(1);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(grief.blockNumber));
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked.plus(1));
      Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked.plus(1).plus(await underlying.balanceOf(strategy.address)));
      assert.equal((await strategy.lastStakeBlock()).toString(), String(lastStake), "lastStakeBlock counts the strategy's own stakes only");
      assert.equal(await nextStakeBlock(), lastStake + interval);

      // so the next stake does not move: one block before lastStakeBlock + minStakeInterval the strategy still waits, and at
      // that block it stakes, long before depositBlock + minStakeInterval
      await depositNewLP();
      await mineToBlock(lastStake + interval - 2);
      let block = await doHardWork();
      assert.equal(block, lastStake + interval - 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      block = await doHardWork();
      assert.equal(block, lastStake + interval);
      assert.isBelow(block, grief.blockNumber + interval);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "an outsider's depositFor should not postpone the stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));

      // under a window, a depositFor from anyone but a MetaRouter Aero approved reverts (PenaltyActive): only the
      // strategy's own stakes move its depositBlock then, so the window term of the next stake can count from it
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        let message = await revertMessage(outsiderDepositFor(1), "depositFor should revert under a window");
        assert.include(message, revertData(web3.eth.abi.encodeFunctionSignature("PenaltyActive()")));
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Stakes at once after a full exit, even when an outsider staked 1 wei for it in between", async function() {
      // withdrawAll empties the gauge: no last stake to wait for any more ...
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
      // ... and an outsider's stake for the strategy is not one of its own; then a user deposits, and the hard work stakes
      await outsiderDepositFor(1);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 1);
      await depositNewLP();
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake at once");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));

      // the same after an emergency exit, and with Aero switching on a window over the outsider's new 1 wei: the strategy
      // waits for that window to claim, but then stakes at once, without stakeSpacing (10 windows after depositBlock) or
      // minStakeInterval to wait for
      await strategy.emergencyExit({ from: governance });
      try {
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), "0", "an emergency exit should reset lastStakeBlock");
      } finally {
        await strategy.continueInvesting({ from: governance });
      }
      let grief = await outsiderDepositFor(1);
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        block = await doHardWork();
        assert.isBelow(block, grief.blockNumber + 7, "should run inside the window of the outsider's stake");
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "the claim should wait for the window");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "the stake should wait for the claim");
        await advanceToBlock(grief.blockNumber + 6);
        block = await doHardWork();
        assert.equal(block, grief.blockNumber + 7);
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0);
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the window");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Under a window, waits for both minStakeInterval after its last stake and stakeSpacing windows after depositBlock", async function() {
      // a 7-block window and stakeSpacing 10: 70 blocks after depositBlock; and an interval of 600, then of 30 blocks
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        for (let [stakeInterval, wait] of [[600, 600], [30, 70]]) {
          await strategy.setMinStakeInterval(stakeInterval, { from: governance });
          // a claim-then-stake at the first block allowed (with farmer1's LP: claimThenStake deposits farmer2's)
          await advanceToBlock(await nextStakeBlock());
          await depositNewLP();
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim outside the window");
          assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
          assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
          assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
          assert.equal(await nextStakeBlock(), block + wait);

          // new LP: after the window the hard work claims, but stakes only at the later of the two
          await depositNewLP();
          await mineToBlock(block + wait - 2);
          let next = await doHardWork();
          assert.equal(next, block + wait - 1);
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          next = await doHardWork();
          assert.equal(next, block + wait);
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Under a window, counts stakeSpacing from the gauge's depositBlock, which an outsider's depositFor before the window moved", async function() {
      // an interval of 30 blocks, and a stake of the strategy's own
      await strategy.setMinStakeInterval(30, { from: governance });
      try {
        await mineToBlock(Number((await strategy.lastStakeBlock()).toString()) + 30);
        await depositNewLP();
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
        let lastStake = block;
        // with no window, an outsider stakes 1 wei for the strategy some 50 blocks later; then Aero switches on a 7-block
        // window (stakeSpacing 10: 70 blocks), which covers that 1 wei and so, by the gauge's books, the whole stake
        await mineBlocks(49);
        let grief = await outsiderDepositFor(1);
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(grief.blockNumber));
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        try {
          assert.equal(await nextStakeBlock(), grief.blockNumber + 70);
          // past that window, 70 blocks after the strategy's own stake (and 30): it claims, but stakes only 70 blocks after
          // the depositBlock the gauge holds, as a stake of its own there would have required
          await depositNewLP();
          await advanceToBlock(lastStake + 79);
          let next = await doHardWork();
          assert.isAtLeast(next, grief.blockNumber + 7, "should run after the outsider's window");
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should wait for stakeSpacing from the gauge's depositBlock");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          await advanceToBlock(grief.blockNumber + 68);
          next = await doHardWork();
          assert.equal(next, grief.blockNumber + 69);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
          next = await doHardWork();
          assert.equal(next, grief.blockNumber + 70);
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
      await assertNoWindow();
    });

    it("Keeps lastStakeBlock through a partial withdrawal, and resets it when a withdrawal empties the gauge", async function() {
      let lastStake = (await strategy.lastStakeBlock()).toString();
      assert.notEqual(lastStake, "0");

      // a user withdrawal taking part of the stake keeps the last stake, and so the interval
      let block = await withdrawFromGauge(1000000);
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), lastStake, "a partial withdrawal should keep lastStakeBlock");

      // each exit that empties the gauge resets it, and the hard work after it stakes everything at once: withdrawToVault
      // (what user withdrawals call) for all of the strategy's LP, withdrawAllToVault, emergencyExit
      let exits = [
        ["withdrawToVault", async () => strategy.withdrawToVault(await strategy.investedUnderlyingBalance(), { from: governance })],
        ["withdrawAllToVault", async () => strategy.withdrawAllToVault({ from: governance, gasPrice: keeperGasPrice })],
        ["emergencyExit", async () => strategy.emergencyExit({ from: governance })],
      ];
      for (let [name, exit] of exits) {
        Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
        try {
          await exit();
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0", name + " should reset lastStakeBlock");
        } finally {
          if (await strategy.pausedInvesting()) {
            await strategy.continueInvesting({ from: governance });
          }
        }
        block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake at once after " + name);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      }
    });

    it("Accepts a minStakeInterval from 0 to 12,960,000 blocks (about 30 days), from governance only", async function() {
      let message = await revertMessage(strategy.setMinStakeInterval(0, { from: farmer2 }), "only governance should set minStakeInterval");
      assert.include(message, "Not governance");
      message = await revertMessage(strategy.setMinStakeInterval(12960001, { from: governance }), "more than 30 days should be rejected");
      assert.include(message, "Invalid stake interval");
      assert.equal((await strategy.minStakeInterval()).toString(), String(interval), "rejected values should change nothing");

      try {
        for (let valid of [12960000, 0, 1]) {
          let tx = await strategy.setMinStakeInterval(valid, { from: governance });
          let changed = await strategyEvents("MinStakeIntervalChanged", tx.receipt.blockNumber);
          assert.equal(changed.length, 1);
          assert.equal(changed[0].args.minStakeInterval.toString(), String(valid));
          assert.equal((await strategy.minStakeInterval()).toString(), String(valid));
        }
      } finally {
        await strategy.setMinStakeInterval(interval, { from: governance });
      }
    });
  });

  describe("Minimum staking period (7 blocks)", function() {
    before(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      await Utils.advanceNBlock(1800); // past the window and the spacing of the last stake, with an hour of rewards
    });

    it("Claims and then stakes in the same transaction, outside the window", async function() {
      await depositVault(farmer2, underlying, vault, farmer2Balance);
      let block = await doHardWork();

      let claimed = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claimed.length, 1, "should claim outside the window");
      lastClaimAmount = new BigNumber(claimed[0].args._rewardAmount.toString());
      Utils.assertBNGt(lastClaimAmount, 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);

      // the window opened with the stake; the next stake waits stakeSpacing (10) windows
      let window = await strategy.penaltyWindow();
      console.log("claimed AERO: ", lastClaimAmount.toFixed(), " window ends at block: ", window.windowEndBlock.toString());
      assert.equal(window.minStakeBlocks.toString(), "7");
      assert.equal(window.windowEndBlock.toString(), String(block + 7));
      assert.equal(window.inWindow, true, "should be inside the window");
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
    });

    it("Skips the claim and the stake inside the window, without reverting", async function() {
      await depositVault(farmer1, underlying, vault, new BigNumber(await underlying.balanceOf(farmer1)));
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      let block = await doHardWork();

      assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "claim should be skipped");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "stake should be skipped");
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
      // the new LP waits, unstaked, in the strategy
      Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);
    });

    it("Pays a withdrawal from idle LP first, without touching the gauge", async function() {
      Utils.assertBNEq(await vault.underlyingBalanceInVault(), 0);
      let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
      let depositBlockBefore = (await gauge.depositBlock(strategy.address)).toString();

      // shares worth half of the idle LP
      let shares = idleBefore.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
      let paid = new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore);

      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the gauge should not be touched");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.minus(paid));
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), depositBlockBefore);
    });

    it("Lets a user withdraw inside the window, losing only the rewards since the last claim", async function() {
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let shares = new BigNumber(await vault.balanceOf(farmer2));
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
      // everything the gauge holds for the strategy as unclaimed: what accrued since the claim-then-stake
      let pending = new BigNumber(await gauge.balanceOf(strategy.address))
        .times(new BigNumber(await gauge.projectedRewardPerToken()).minus(await gauge.userRewardPerTokenPaid(strategy.address)))
        .idiv(1e18)
        .plus(await gauge.rewards(strategy.address));

      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
      let received = new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore);

      // full pro-rata LP, never blocked; the idle LP was used first
      Utils.assertBNEq(received, expected);
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1);
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));

      // the gauge forfeits the pending rewards, but those are only a few blocks old
      let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
      assert.equal(penalties.length, 1);
      let lost = new BigNumber(penalties[0].args._penalty.toString());
      console.log("AERO lost: ", lost.toFixed(), " vs AERO claimed before the stake: ", lastClaimAmount.toFixed());
      Utils.assertBNGte(lost, pending); // what was pending (plus the block of the withdrawal) ...
      Utils.assertBNGt(lastClaimAmount, lost.times(100)); // ... is tiny next to what the claim-then-stake protected
      Utils.assertBNGte(received, farmer2Balance.minus(10));
    });

    it("Claims after the window, but waits stakeSpacing windows before staking again", async function() {
      let depositBlock = Number((await gauge.depositBlock(strategy.address)).toString());
      await advanceToBlock(depositBlock + 7);
      assert.equal((await strategy.penaltyWindow()).inWindow, false, "should be outside the window");

      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);

      // the first block where staking is allowed again:
      // last deposit (windowEndBlock - minStakeBlocks) + stakeSpacing * minStakeBlocks
      let window = await strategy.penaltyWindow();
      let minStakeBlocks = Number(window.minStakeBlocks.toString());
      let nextStakeBlock = Number(window.windowEndBlock.toString()) - minStakeBlocks
        + Number((await strategy.stakeSpacing()).toString()) * minStakeBlocks;
      assert.equal(nextStakeBlock, depositBlock + 70);

      // one block earlier it still waits
      await advanceToBlock(nextStakeBlock - 2);
      block = await doHardWork();
      assert.equal(block, nextStakeBlock - 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "one block early: should not stake yet");
      assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);

      // the next hard work lands exactly on that block, and stakes
      block = await doHardWork();
      assert.equal(block, nextStakeBlock);
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Can withdraw everything to the vault inside the window", async function() {
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let total = new BigNumber(await vault.underlyingBalanceWithInvestment());

      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });

      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      // a full exit clears the gauge timer, and the strategy's own record of its last stake
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0");
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
    });

    it("Can exit in an emergency inside the window", async function() {
      // the vault invests again; nothing is staked, so the strategy claims (nothing) and stakes
      await doHardWork();
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);

      await strategy.emergencyExit({ from: governance });
      try {
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        // and every hard work reverts until governance resumes investing
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "hard work should revert while investing is paused");
        assert.include(message, "Action blocked as the strategy is in emergency state");
      } finally {
        await strategy.continueInvesting({ from: governance });
      }
    });

    it("Handles Aero lengthening the window after the stake", async function() {
      await Utils.advanceNBlock(7);
      await doHardWork(); // stakes with a 7-block window

      // retroactive: our existing stake is now inside a 1000-block window
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 1000, { from: penaltyAdmin });
      await Utils.advanceNBlock(20);
      let block = await doHardWork();
      assert.equal((await strategyEvents("ClaimSkipped", block)).length, 1, "claim should be skipped");
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);

      await Utils.advanceNBlock(1000);
      block = await doHardWork();
      let claimed = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claimed.length, 1, "should claim once the longer window is over");
      Utils.assertBNGt(claimed[0].args._rewardAmount.toString(), 0);
      assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
    });
  });

  describe("Minimum staking period: Aero and governance settings (7 blocks)", function() {
    before(async function() {
      // back to a 7-block window: the last stake is long past it and its stakeSpacing
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
    });

    it("Claims and stakes on every hard work while Aero charges no penalty, even with a window, and stakes even when the claim fails", async function() {
      let block = await claimThenStake(await farmer2LP(10));
      let config = await gaugeFactoryGovernance.methods.penaltyConfig().call();
      assert.equal(config.penaltyRate.toString(), "1000000", "Aero's default should forfeit everything inside the window");

      // Aero stops charging the penalty, factory-wide (setPenaltyConfig also sets the default window: kept as it is);
      // the gauge keeps its own 7-block window
      await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, 0).send({ from: penaltyAdmin });
      try {
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), "7");
        assert.equal(window.penaltyRate.toString(), "0");
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, false, "nothing can be forfeited, so there is nothing to wait for");

        // so every hard work claims and stakes: inside the 7 blocks after the last stake, long before stakeSpacing (and with
        // minStakeInterval 0, set in the root before(), nothing else spaces the stakes)
        for (let i = 0; i < 2; i++) {
          let lastStake = Number((await gauge.depositBlock(strategy.address)).toString());
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          block = await doHardWork();
          assert.isBelow(block, lastStake + 7, "should run inside the window of the last stake");
          assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0, "should not skip the claim");
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "should not wait for stakeSpacing");
          assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        }

        // a user withdrawal reaching the gauge right after a stake keeps all the strategy earned since then
        let shares = new BigNumber(await vault.balanceOf(farmer2)).div(2).integerValue(BigNumber.ROUND_DOWN);
        let before = await gaugeCheckpoint();
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 1, "the withdrawal should reach the gauge");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0, "nothing should be forfeited");
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1);
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));

        // with nothing to forfeit a stake cannot cost rewards either, so it does not wait for a claim: the hard work stakes
        // even when its claim fails (minting paused), still inside the 7 blocks of the last stake
        let lastStake = Number((await gauge.depositBlock(strategy.address)).toString());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let idle = await unstakedLP();
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          block = await doHardWork();
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
        assert.isBelow(block, lastStake + 7, "should run inside the window of the last stake");
        let failures = await strategyEvents("ClaimFailed", block);
        assert.equal(failures.length, 1, "the claim should fail without reverting");
        assert.notEqual(failures[0].args.reason, insufficientGasError, "minting paused, not Aero's gas check");
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0, "should not skip the claim");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "nothing can be forfeited at a zero penalty: the stake should not wait for a claim");
        assert.equal((await strategyEvents("StakeFailed", block)).length, 0);
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake without the claim");
        let minted = await mintedLP(block);
        console.log("staked without a claim at a zero penalty: ", deposits[0].args._amount.toString(), " (idle LP ", idle.toFixed(),
          ", compounded ", minted.toFixed(), "); claim failure: ", failures[0].args.reason);
        Utils.assertBNEq(deposits[0].args._amount.toString(), idle.plus(minted));
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      } finally {
        await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, config.penaltyRate).send({ from: penaltyAdmin });
      }

      // with the penalty back, the last stake is inside its window again
      let window = await strategy.penaltyWindow();
      assert.equal(window.penaltyRate.toString(), "1000000");
      assert.equal(window.inWindow, true, "should be inside the window again");
    });

    it("Still skips the claim at a 50% penalty, and a withdrawal inside the window forfeits half of the rewards since the last claim", async function() {
      let config = await gaugeFactoryGovernance.methods.penaltyConfig().call();
      await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, 500000).send({ from: penaltyAdmin });
      try {
        // half of farmer2's LP is staked, so that its withdrawal below reaches the gauge
        let block = await claimThenStake(await farmer2LP(2));
        let window = await strategy.penaltyWindow();
        assert.equal(window.penaltyRate.toString(), "500000");
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, true, "a partial penalty should still make a window");

        // inside the window a claim would lose half of the rewards: the hard work skips the claim and the stake
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let skippedBlock = await doHardWork();
        let skipped = await strategyEvents("ClaimSkipped", skippedBlock);
        assert.equal(skipped.length, 1, "claim should be skipped");
        assert.equal(skipped[0].args.windowEndBlock.toString(), String(block + 7));
        assert.equal((await strategyEvents("StakeSkipped", skippedBlock)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", skippedBlock)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", skippedBlock)).length, 0);

        // farmer2 withdraws everything inside the window: the gauge claims all the strategy earned since the
        // claim-then-stake, forfeits half of it and pays the other half to the strategy
        let shares = new BigNumber(await vault.balanceOf(farmer2));
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));

        let reward = (await accruedSince(before)).plus(before.rewards);
        let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
        assert.equal(penalties.length, 1);
        let lost = new BigNumber(penalties[0].args._penalty.toString());
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1, "the other half should be paid");
        let kept = new BigNumber(claimed[0].args._rewardAmount.toString());
        console.log("AERO earned since the last claim: ", reward.toFixed(), " lost: ", lost.toFixed(), " kept: ", kept.toFixed());
        Utils.assertBNGt(reward, 0);
        Utils.assertBNEq(lost, reward.times(500000).idiv(1000000)); // the penalty share, rounded down by the gauge
        Utils.assertBNEq(kept, reward.minus(lost));
        Utils.assertBNEq(new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(aeroBefore), kept);

        // a withdrawal does not restart the window: the claim is free again at the stake's windowEndBlock
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
        await advanceToBlock(block + 6);
        let next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should still wait for stakeSpacing");
      } finally {
        await gaugeFactoryGovernance.methods.setPenaltyConfig(config.minStakeBlocks, config.penaltyRate).send({ from: penaltyAdmin });
      }
      assert.equal((await strategy.penaltyWindow()).penaltyRate.toString(), "1000000");
    });

    it("Claims and stakes at once when Aero removes the window while the strategy is inside one, and no longer needs the claim to stake", async function() {
      let block = await claimThenStake(await farmer2LP(10));
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));

      // Aero sets the gauge back to the factory default: no window
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      try {
        await assertNoWindow();
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), "0");
        assert.equal(window.windowEndBlock.toString(), String(block), "a 0-block window should end where it starts");
        assert.equal(window.inWindow, false, "should be outside any window");

        // still inside the old 7 blocks and far from the old stakeSpacing, the next hard work claims and stakes (with no
        // window only minStakeInterval spaces the stakes, and it is 0 here: root before())
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the old window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0, "should not skip the claim");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 0, "should not wait for stakeSpacing");
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);

        // with no window a stake cannot cost rewards, so it no longer waits for a claim: not even while minting is paused
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          next = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 1, "claim should fail without reverting");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 0, "should not wait for a claim");
          assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake without the claim");
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      }

      // the window is back, from that new stake
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window again");
    });

    it("With stakeSpacing 1, claims and stakes again in the first hard work after the window", async function() {
      let tx = await strategy.setStakeSpacing(1, { from: governance });
      try {
        let changed = await strategyEvents("StakeSpacingChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.stakeSpacing.toString(), "1");
        let block = await claimThenStake(await farmer2LP(10));
        // the next stake is allowed where the window ends
        assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(block + 7));
        assert.equal(await nextStakeBlock(), block + 7);

        // new LP waits until the last block of the window
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(block + 5);
        let next = await doHardWork();
        assert.equal(next, block + 6);
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0);

        // and the first block after the window both claims and stakes
        next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake right after the claim");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
    });

    it("With the maximum stakeSpacing (1000), keeps new LP idle for 1000 windows, while withdrawals still work", async function() {
      // only governance can set it, from 1 to 1000
      let message = await revertMessage(strategy.setStakeSpacing(0, { from: governance }), "a stakeSpacing of 0 should be rejected");
      assert.include(message, "Invalid stake spacing");
      message = await revertMessage(strategy.setStakeSpacing(1001, { from: governance }), "a stakeSpacing above 1000 should be rejected");
      assert.include(message, "Invalid stake spacing");
      message = await revertMessage(strategy.setStakeSpacing(1000, { from: farmer2 }), "only governance should set stakeSpacing");
      assert.include(message, "Not governance");

      // half of farmer2's LP is staked, so that its withdrawal below reaches the gauge
      let block = await claimThenStake(await farmer2LP(2));
      await strategy.setStakeSpacing(1000, { from: governance });
      try {
        let stakeBlock = await nextStakeBlock();
        assert.equal(stakeBlock, block + 7000);

        // after the window it claims and compounds, but the new LP stays idle
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(block + 6);
        let next = await doHardWork();
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake yet");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        // the idle LP still counts in the strategy's value, and so in the vault's share price
        await assertIdleLPCounted();
        // long after the default stakeSpacing (70 blocks), still
        await advanceToBlock(block + 699);
        next = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake yet");
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idleBefore, 0);
        await assertIdleLPCounted();

        // meanwhile a withdrawal is paid from the idle LP first ...
        let shares = idleBefore.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        let paid = new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore);
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the gauge should not be touched");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.minus(paid));
        // ... and from the gauge for the rest, outside the window: nothing is forfeited
        shares = new BigNumber(await vault.balanceOf(farmer2));
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected.minus(idleBefore));
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber)).length, 0);
        // the stake keeps its deposit block, so the next stake is as far away as before
        assert.equal(await nextStakeBlock(), stakeBlock);

        // one block before the 1000th window ends it still waits, then it stakes
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        await advanceToBlock(stakeBlock - 2);
        next = await doHardWork();
        assert.equal(next, stakeBlock - 1);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "one block early: should not stake yet");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        next = await doHardWork();
        assert.equal(next, stakeBlock);
        assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
    });

    it("With nothing staked, stakes at once even under Aero's longest window and the maximum stakeSpacing", async function() {
      // nothing staked: no window, and no last stake to space the next one from
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0");
      let lpBefore = await unstakedLP();

      // the longest window Aero allows, and the maximum stakeSpacing: 1000 windows of 90000 blocks counted from block 0
      // would end at block 90,000,000, long after this one
      let maxWindow = Number(await gaugeFactoryGovernance.methods.MAX_MIN_STAKE_BLOCKS().call());
      assert.equal(maxWindow, 90000);
      await strategy.setStakeSpacing(1000, { from: governance });
      try {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, maxWindow, { from: penaltyAdmin });
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), String(maxWindow));
        assert.equal(window.windowEndBlock.toString(), "0", "nothing staked: no window");
        assert.equal(window.inWindow, false);

        // the next hard work claims (nothing is owed) and stakes everything at once
        let block = await doHardWork();
        assert.isBelow(block, 1000 * maxWindow);
        assert.equal((await strategyEvents("ClaimSkipped", block)).length, 0, "should not skip the claim");
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 0);
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "the first stake should not wait for stakeSpacing");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        // and that stake opens the whole window
        window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(block + maxWindow));
        assert.equal(window.inWindow, true, "should be inside the window");
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        await strategy.setStakeSpacing(10, { from: governance });
      }
      assert.equal((await strategy.stakeSpacing()).toString(), "10");
      assert.equal((await strategy.penaltyWindow()).minStakeBlocks.toString(), "7");
    });

    it("Takes the stake out of a gauge Aero switched off with its first claim after the window, without waiting for stakeSpacing, and keeps new LP unstaked where stakeSpacing allows a stake", async function() {
      let cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      let block = await claimThenStake(await farmer2LP(10));
      let stakeBlock = await nextStakeBlock();
      assert.equal(stakeBlock, block + 70);
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP

      // Aero switches the gauge off while the stake is inside its window
      await setEmissionCap(0);
      try {
        assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), "0");
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));

        // a switched-off gauge pays no AERO and its stakers get no pool fees: the strategy leaves it, but not inside the
        // window, where it can claim nothing and leaving would forfeit all the stake earned since the claim-then-stake
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await gaugeEvents("Withdraw", next)).length, 0, "should not leave the gauge without a claim");
        assert.equal((await strategyEvents("UnstakedFromGauge", next)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the first hard work after the window claims (the AERO earned before the switch-off), then takes the whole stake
        // out in the same transaction, with nothing left to forfeit. It leaves at once, 63 blocks before stakeSpacing would
        // allow a stake: stakeSpacing and minStakeInterval only space stakes. Nothing is staked, and the LP waits
        await advanceToBlock(block + 6);
        let before = await gaugeCheckpoint();
        next = await doHardWork();
        assert.equal(next, block + 7, "should run at the first block after the window");
        assert.isBelow(next, stakeBlock, "should leave long before stakeSpacing would allow a stake");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0);
        assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
        let claimed = await gaugeEvents("EmissionsClaimed", next);
        assert.equal(claimed.length, 1, "should claim");
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
        let withdrawn = await gaugeEvents("Withdraw", next);
        assert.equal(withdrawn.length, 1, "should take the stake out right after the claim");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        let unstaked = await strategyEvents("UnstakedFromGauge", next);
        assert.equal(unstaked.length, 1);
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("EmergencyWithdraw", next)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0", "no window left to wait for");
        assert.equal((await strategy.lastStakeBlock()).toString(), "0");
        assert.equal(await nextStakeBlock(), 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, staked);
        let skipped = await strategyEvents("StakeSkipped", next);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        await assertIdleLPCounted();

        // where the stakeSpacing of the old stake would have allowed a stake, the gauge still switched off: nothing to claim
        // or to take out, and all the LP stays unstaked
        await advanceToBlock(stakeBlock - 1);
        next = await doHardWork();
        assert.isAtLeast(next, stakeBlock, "should be past the old stake's stakeSpacing");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0, "nothing staked: nothing to claim");
        assert.equal((await gaugeEvents("Withdraw", next)).length, 0);
        assert.equal((await strategyEvents("UnstakedFromGauge", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        skipped = await strategyEvents("StakeSkipped", next);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));

        // the same without a window: nothing is left to unstake, and nothing is staked
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        try {
          await assertNoWindow();
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          next = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0, "nothing staked: nothing to claim");
          assert.equal((await gaugeEvents("Withdraw", next)).length, 0);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        }
      } finally {
        await setEmissionCap(cap);
      }

      // switched back on: nothing is staked, so the next hard work claims (nothing) and stakes all the LP at once
      assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), cap);
      let next = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Runs a hard work that governance calls directly while investOnDeposit is on, under the same window rules", async function() {
      // while the flag is on a user deposit reverts (it would run the hard work), so new LP reaches the strategy before: a
      // deposit, and a keeper hard work inside the window of the last stake, which invests it and skips the claim and the
      // stake
      let block = await claimThenStake(await farmer2LP(10));
      let stakeBlock = await nextStakeBlock();
      assert.equal(stakeBlock, block + 70);
      let amount = await farmer2LP(10);
      await depositVault(farmer2, underlying, vault, amount);
      let next = await doHardWork();
      assert.isBelow(next, block + 7, "should run inside the window");
      assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
      assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
      Utils.assertBNGte(await underlying.balanceOf(strategy.address), amount);

      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        // governance calling the strategy itself is not refused: still inside the window, it skips the claim and the stake,
        // like a keeper hard work
        let tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        next = tx.receipt.blockNumber;
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
        assert.equal((await gaugeEvents("Deposit", next)).length, 0);

        // after the window it claims, and waits for stakeSpacing to stake
        await advanceToBlock(block + 6);
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        next = tx.receipt.blockNumber;
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should still wait for stakeSpacing");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);

        // meanwhile a user deposit reverts, and so does the keeper's hard work through the vault
        let deposit = await farmer2LP(10);
        await underlying.approve(vault.address, deposit, { from: farmer2 });
        let message = await revertMessage(vault.deposit(deposit, farmer2, { from: farmer2 }), "a user deposit should revert while investOnDeposit is on");
        assert.include(message, "investOnDeposit or compoundOnWithdraw is on");
        message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "the keeper's hard work should revert while investOnDeposit is on");
        assert.include(message, "investOnDeposit or compoundOnWithdraw is on");

        // outside the window and past stakeSpacing, governance's own hard work claims and stakes
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGte(idle, amount);
        await advanceToBlock(stakeBlock - 1);
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        next = tx.receipt.blockNumber;
        assert.equal(next, stakeBlock);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", next);
        assert.equal(deposits.length, 1, "should stake right after the claim");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(next + 7));
        assert.equal(window.inWindow, true, "should be inside the window");
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }
    });
  });

  describe("Gauge switched off by Aero (no window)", function() {
    let cap;
    let previousWindow;

    before(async function() {
      previousWindow = (await gaugeFactory.effectivePenaltyConfig(gaugeAddress)).minStakeBlocks.toString();
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      await assertNoWindow();
      cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      await doHardWork(); // everything staked
    });

    after(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
    });

    it("Takes the whole stake out right after its claim, through the gauge's normal withdraw, with nothing forfeited", async function() {
      await mineBlocks(1800); // an hour of rewards
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let unstakedBefore = await unstakedLP();
        let value = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let before = await gaugeCheckpoint();
        let block = await doHardWork();

        // the claim pays all the stake earned, so the exit right after it, in the same transaction, finds nothing to forfeit
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should claim");
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
        let withdrawn = await gaugeEvents("Withdraw", block);
        assert.equal(withdrawn.length, 1, "should take the stake out through the normal withdraw");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        let unstaked = await strategyEvents("UnstakedFromGauge", block);
        assert.equal(unstaked.length, 1);
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
        assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
        let forfeited = await leafVoterEvents.getPastEvents("EmissionsForfeited", { filter: { _gauge: gaugeAddress }, fromBlock: block, toBlock: block });
        assert.equal(forfeited.length, 0, "nothing should be forfeited");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), "0");

        // all the LP waits in the strategy and keeps counting: the vault's value only grew, by the LP compounded from the claim
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        let compounded = await mintedLP(block);
        Utils.assertBNGt(compounded, 0);
        Utils.assertBNEq(idle, unstakedBefore.plus(staked).plus(compounded));
        let skipped = await strategyEvents("StakeSkipped", block);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        Utils.assertBNEq(await vault.underlyingBalanceWithInvestment(), value.plus(compounded));
        await assertIdleLPCounted();

        // from then on there is nothing to claim or to take out, and the LP stays idle
        block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
        assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
        assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
      } finally {
        await setEmissionCap(cap);
      }
    });

    it("Earns pool fees on the LP it took out, and compounds them into LP with no AERO to sell", async function() {
      // still out of the gauge (switched off again before any hard work could stake): the idle LP earns its share of the
      // fees of every swap through the pool
      await setEmissionCap(0);
      try {
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        let feesBefore = await pendingFees();
        await burnLP(20);
        for (let i = 0; i < 3; i++) {
          await poolSwap(farmer2, usdc, (await usdcToken.balanceOf(farmer2)).toString());
          await poolSwap(farmer2, alusdb, (await alusdbToken.balanceOf(farmer2)).toString());
        }
        let pending = await pendingFees();
        Utils.assertBNGt(await dollars(pending.amount0, pending.amount1), await dollars(feesBefore.amount0, feesBefore.amount1));

        let sharePrice = new BigNumber(await vault.getPricePerFullShare());
        let block = await doHardWork();
        let claims = await feeClaims(block);
        assert.equal(claims.length, 1, "should claim the pool fees");
        Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
        Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
        // nothing staked, so no AERO claimed or sold, and still the fees go into the pool
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "no AERO to sell");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the fees");
        let compounded = await mintedLP(block);
        Utils.assertBNGt(compounded, 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle.plus(compounded));
        Utils.assertBNGt(await vault.getPricePerFullShare(), sharePrice);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
        // almost nothing is left over: the zap put the fees into the pool in its own ratio
        let fees = await dollars(pending.amount0, pending.amount1);
        let leftover = await poolTokensHeld();
        console.log("pool fees ($, 18 decimals): ", fees.toFixed(), " compounded into LP worth: ", (await lpDollars(compounded)).toFixed(),
          " left over: ", leftover.toFixed());
        Utils.assertBNGt(fees, leftover.times(100)); // leftover below 1% of the fees
      } finally {
        await setEmissionCap(cap);
      }
    });

    it("Stakes all the idle LP at once when Aero switches the gauge back on, even with the default minStakeInterval", async function() {
      // the full exit from the switched-off gauge reset lastStakeBlock: no interval to wait for
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      Utils.assertBNGt(idle, 0);
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        let block = await doHardWork();
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Takes the stake out of a switched-off gauge with its first claim, without waiting for minStakeInterval after its last stake", async function() {
      // with the default interval, a stake made a moment ago (the test above) keeps the next stake about a day of blocks
      // away; that only spaces stakes: a gauge Aero switches off is left with the first claim that goes through
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        let lastStake = Number((await strategy.lastStakeBlock()).toString());
        assert.notEqual(lastStake, 0);
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        await mineBlocks(600); // AERO to claim
        await setEmissionCap(0);
        try {
          let before = await gaugeCheckpoint();
          let block = await doHardWork();
          assert.isBelow(block, lastStake + 432000, "should run long before minStakeInterval would allow a stake");
          let claimed = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(claimed.length, 1, "should claim");
          Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
          let withdrawn = await gaugeEvents("Withdraw", block);
          assert.equal(withdrawn.length, 1, "should take the stake out right after the claim");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          let unstaked = await strategyEvents("UnstakedFromGauge", block);
          assert.equal(unstaked.length, 1);
          Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
          let skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
          await assertIdleLPCounted();
        } finally {
          await setEmissionCap(cap);
        }

        // switched back on: nothing staked and no last stake, so the next hard work stakes at once, interval or not
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Keeps the stake in a switched-off gauge while its claim fails (minting paused), and takes it out with the next claim that goes through", async function() {
      await mineBlocks(600);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      await setEmissionCap(0);
      try {
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          let block = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "claim should fail without reverting");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0, "should not leave the gauge without a claim");
          assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.notEqual((await strategy.lastStakeBlock()).toString(), "0");
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }

        let block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let unstaked = await strategyEvents("UnstakedFromGauge", block);
        assert.equal(unstaked.length, 1, "should leave the gauge right after the claim");
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("Withdraw", block)).length, 1);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await setEmissionCap(cap);
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Reverts the whole hard work, claim included, when too little gas is left to leave a switched-off gauge", async function() {
      await mineBlocks(600);
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let before = await gaugeCheckpoint();
        let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));

        // the exit is best effort (_tryExitGauge): it starts only with gaugeTapeGasLimit + 1,200,000 gas left, so that a
        // keeper that sent too little gas retries with more. The least keeper gas that gets through is set by that floor:
        // 300,000 gas less leaves too little at the exit, after the claim and the liquidation, and the hard work reverts as
        // a whole
        let least = await leastGas({ from: governance, to: controller.address, gasPrice: keeperGasPrice,
          data: controller.contract.methods.doHardWork(vault.address).encodeABI() }, 1000000, 8000000);
        console.log("least keeper gas for the hard work that leaves the switched-off gauge: ", least, " exit floor: ", await exitGasFloor());
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: least - 300000 }),
          "the hard work should revert with too little gas for the exit");
        assert.include(message, "Not enough gas for the gauge");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid); // nothing claimed
        Utils.assertBNEq(await gauge.rewards(strategy.address), before.rewards);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle);

        // with enough gas, the same hard work claims and leaves (a margin over the simulated least gas: a block later the hard
        // work claims a little more and its liquidation may take another swap)
        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: least + 200000 });
        let block = tx.receipt.blockNumber;
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 1, "should leave the gauge");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await setEmissionCap(cap);
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Leaves a switched-off gauge through emergencyWithdraw when its withdraw fails after the claim, and keeps the stake when Aero has not enabled it", async function() {
      await mineBlocks(600);
      await setEmissionCap(0);
      try {
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let lastStake = (await strategy.lastStakeBlock()).toString();

        // the gauge's withdraw fails right after the claim. With emergencyWithdraw disabled the exit fails too: the hard work
        // reports it, keeps the stake and goes on
        await withGaugeFailingAfterClaim(async () => {
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "the claim should go through");
          let failures = await strategyEvents("GaugeExitFailed", block);
          assert.equal(failures.length, 1, "the exit should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);
        });

        // enabled: the exit falls back to emergencyWithdraw. The gauge first runs switched on for a while, so that the
        // stake has AERO to claim again
        await setEmissionCap(cap);
        await mineBlocks(600);
        await setEmissionCap(0);
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        try {
          await withGaugeFailingAfterClaim(async () => {
            let before = await gaugeCheckpoint();
            let block = await doHardWork();
            // emergencyWithdraw does no emission accounting (V2Gauge.emergencyWithdraw): it never reports a penalty or a
            // forfeit, it just leaves unpaid whatever the stake earned since its last checkpoint. That checkpoint is the
            // claim right before it, in the same transaction: the claim paying everything the stake earned is what shows
            // that nothing is lost, and the strategy is owed nothing after the exit
            let claimed = await gaugeEvents("EmissionsClaimed", block);
            assert.equal(claimed.length, 1, "the claim should go through");
            Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
            let exits = await gaugeEvents("EmergencyWithdraw", block);
            assert.equal(exits.length, 1, "should leave through emergencyWithdraw");
            Utils.assertBNEq(exits[0].args._amount.toString(), staked);
            let unstaked = await strategyEvents("UnstakedFromGauge", block);
            assert.equal(unstaked.length, 1);
            Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
            assert.equal((await strategyEvents("GaugeExitFailed", block)).length, 0);
            Utils.assertBNEq(await gauge.rewards(strategy.address), 0);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          });
        } finally {
          await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        }
      } finally {
        await setEmissionCap(cap);
      }

      // with the gauge working and on again, the next hard work stakes everything at once
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });
  });

  describe("Kept unstaked by governance (no window)", function() {
    // governance's switch for a gauge that Aero stops paying without switching it off (a full shutdown, which the emission
    // cap check can miss): the strategy then treats the gauge as switched off, while Aero still pays it here
    let cap;
    let previousWindow;

    before(async function() {
      previousWindow = (await gaugeFactory.effectivePenaltyConfig(gaugeAddress)).minStakeBlocks.toString();
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      await assertNoWindow();
      cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      assert.equal(await strategy.keepUnstaked(), false);
      await doHardWork(); // everything staked
    });

    after(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
    });

    // governance switches keepUnstaked to `value`, and each call is reported
    async function setKeepUnstaked(value) {
      let tx = await strategy.setKeepUnstaked(value, { from: governance });
      let changed = await strategyEvents("KeepUnstakedChanged", tx.receipt.blockNumber);
      assert.equal(changed.length, 1, "each call should be reported");
      assert.equal(changed[0].args.keepUnstaked, value);
      assert.equal(await strategy.keepUnstaked(), value);
    }

    // what the gauge's LeafVoter took back from the gauge in `block`: forfeited penalties, emissions nobody could earn
    async function forfeited(block) {
      return await leafVoterEvents.getPastEvents("EmissionsForfeited", { filter: { _gauge: gaugeAddress }, fromBlock: block, toBlock: block });
    }

    // farmer2 swaps through the pool, both ways, whose fees go to the LP held out of the gauge; returns the pool fees the
    // strategy is then owed, which must have grown
    async function swapThroughPool() {
      let feesBefore = await pendingFees();
      await burnLP(100);
      await poolSwap(farmer2, usdc, (await usdcToken.balanceOf(farmer2)).toString());
      await poolSwap(farmer2, alusdb, (await alusdbToken.balanceOf(farmer2)).toString());
      let pending = await pendingFees();
      Utils.assertBNGt(await dollars(pending.amount0, pending.amount1), await dollars(feesBefore.amount0, feesBefore.amount1));
      return pending;
    }

    // a hard work with nothing staked, kept unstaked: it claims the pool fees `pending` and compounds them into LP, which
    // stays idle with the rest
    async function compoundFeesUnstaked(pending) {
      let idle = await unstakedLP();
      let sharePrice = new BigNumber(await vault.getPricePerFullShare());
      let block = await doHardWork();
      let claims = await feeClaims(block);
      assert.equal(claims.length, 1, "should claim the pool fees");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the fees");
      let compounded = await mintedLP(block);
      Utils.assertBNGt(compounded, 0);
      Utils.assertBNGt(await vault.getPricePerFullShare(), sharePrice);
      // nothing staked, so nothing to take out, and nothing staked either
      assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
      assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should keep the LP unstaked");
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle.plus(compounded));
      let skipped = await strategyEvents("StakeSkipped", block);
      assert.equal(skipped.length, 1);
      Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle.plus(compounded));
      await assertIdleLPCounted();
      return block;
    }

    it("Keeps the value governance sets when it sets the same value again, and reports every call", async function() {
      // a repeated call (a multisig transaction sent again, a script that switches it on at every step) must leave the
      // switch as governance set it: a setter that toggled would turn the switch off with a repeated switch-on, one that
      // refused a call changing nothing would make a batch with it revert, and one that reported only changes would hide
      // the call. The calls run on a snapshot that the test reverts, so the tests after it see the chain as before
      let snapshot = await hre.network.provider.send("evm_snapshot", []);
      try {
        await setKeepUnstaked(true);
        await setKeepUnstaked(true);
        await setKeepUnstaked(false);
        await setKeepUnstaked(false);
      } finally {
        await hre.network.provider.send("evm_revert", [snapshot]);
      }
      assert.equal(await strategy.keepUnstaked(), false);
    });

    it("Takes the whole stake out of a gauge Aero still pays right after its claim, once governance keeps the LP unstaked, with nothing forfeited", async function() {
      await mineBlocks(1800); // an hour of rewards
      try {
        await setKeepUnstaked(true);
        // Aero has not switched the gauge off
        Utils.assertBNEq(await gaugeFactory.emissionCap(gaugeAddress), cap);
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let unstakedBefore = await unstakedLP();
        let value = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let before = await gaugeCheckpoint();
        let block = await doHardWork();

        // as from a gauge Aero switched off: the claim pays all the stake earned, so the exit right after it, in the same
        // transaction and through the gauge's normal withdraw, finds nothing to forfeit
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should claim");
        Utils.assertBNGt(claimed[0].args._rewardAmount.toString(), 0);
        Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
        let withdrawn = await gaugeEvents("Withdraw", block);
        assert.equal(withdrawn.length, 1, "should take the stake out through the normal withdraw");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        let unstaked = await strategyEvents("UnstakedFromGauge", block);
        assert.equal(unstaked.length, 1);
        Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
        assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
        assert.equal((await forfeited(block)).length, 0, "nothing should be forfeited");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        assert.equal((await strategy.lastStakeBlock()).toString(), "0");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake while kept unstaked");

        // all the LP waits in the strategy and keeps counting: the vault's value only grew, by the LP compounded from the
        // claim, so the exit itself changed nothing
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        let compounded = await mintedLP(block);
        Utils.assertBNGt(compounded, 0);
        Utils.assertBNEq(idle, unstakedBefore.plus(staked).plus(compounded));
        let skipped = await strategyEvents("StakeSkipped", block);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        Utils.assertBNEq(await vault.underlyingBalanceWithInvestment(), value.plus(compounded));
        await assertIdleLPCounted();
        Utils.assertBNEq(await gaugeFactory.emissionCap(gaugeAddress), cap);
      } finally {
        await strategy.setKeepUnstaked(false, { from: governance });
      }
    });

    it("Keeps new LP idle while kept unstaked, and compounds the pool fees its idle LP earns into LP", async function() {
      // nothing staked since the exit above: all the LP is out of the gauge, and earns its share of every swap's fees
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      try {
        await setKeepUnstaked(true);
        for (let i = 0; i < 2; i++) {
          await depositVault(farmer2, underlying, vault, await farmer2LP(20)); // new LP
          let block = await compoundFeesUnstaked(await swapThroughPool());
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0, "nothing staked: nothing to claim");
        }
      } finally {
        await strategy.setKeepUnstaked(false, { from: governance });
      }
    });

    it("Stakes all the idle LP at once when governance switches keepUnstaked off, even with the default minStakeInterval", async function() {
      // the exit with the switch on emptied the gauge and reset lastStakeBlock: no interval to wait for once it is off
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      assert.equal((await strategy.lastStakeBlock()).toString(), "0");
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        try {
          await setKeepUnstaked(true);
          // while it is on, new LP stays idle
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          let block = await doHardWork();
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should keep the LP unstaked");
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
          let idle = new BigNumber(await underlying.balanceOf(strategy.address));
          Utils.assertBNGt(idle, 0);

          // switched off, the next hard work stakes all of it at once
          await setKeepUnstaked(false);
          block = await doHardWork();
          let deposits = await gaugeEvents("Deposit", block);
          assert.equal(deposits.length, 1, "should stake at once");
          Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 0);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
        } finally {
          if (await strategy.keepUnstaked()) {
            await strategy.setKeepUnstaked(false, { from: governance });
          }
        }
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Under a window, takes the stake out only with its first claim after the window, without waiting for stakeSpacing", async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        // a stake inside its window when governance switches keepUnstaked on, and new LP
        let block = await claimThenStake(await farmer2LP(10));
        let stakeBlock = await nextStakeBlock();
        assert.equal(stakeBlock, block + 70);
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        try {
          await setKeepUnstaked(true);
          let staked = new BigNumber(await gauge.balanceOf(strategy.address));

          // inside the window it can claim nothing, and leaving would forfeit all the stake earned since the
          // claim-then-stake: the stake stays, and the new LP waits unstaked
          let next = await doHardWork();
          assert.isBelow(next, block + 7, "should run inside the window");
          assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
          assert.equal((await gaugeEvents("Withdraw", next)).length, 0, "should not leave the gauge without a claim");
          assert.equal((await strategyEvents("UnstakedFromGauge", next)).length, 0);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake while kept unstaked");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

          // the first hard work after the window claims, then takes the whole stake out in the same transaction, with
          // nothing left to forfeit, 63 blocks before stakeSpacing would allow a stake
          await advanceToBlock(block + 6);
          let before = await gaugeCheckpoint();
          next = await doHardWork();
          assert.equal(next, block + 7, "should run at the first block after the window");
          assert.isBelow(next, stakeBlock, "should leave long before stakeSpacing would allow a stake");
          assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0);
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
          let claimed = await gaugeEvents("EmissionsClaimed", next);
          assert.equal(claimed.length, 1, "should claim");
          Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
          let withdrawn = await gaugeEvents("Withdraw", next);
          assert.equal(withdrawn.length, 1, "should take the stake out right after the claim");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          let unstaked = await strategyEvents("UnstakedFromGauge", next);
          assert.equal(unstaked.length, 1);
          Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", next)).length, 0);
          assert.equal((await forfeited(next)).length, 0, "nothing should be forfeited");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0", "no window left to wait for");
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          assert.equal(await nextStakeBlock(), 0);
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake while kept unstaked");
          let skipped = await strategyEvents("StakeSkipped", next);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
          await assertIdleLPCounted();
        } finally {
          await strategy.setKeepUnstaked(false, { from: governance });
        }
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();

      // switched off, with nothing staked: the next hard work stakes all the LP at once
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Under a window, stakes right after its claim, keeps the stake while the claim is skipped and takes it out with the first claim after the window, also while the liquidation fails as a whole", async function() {
      // a liquidation that fails as a whole (here the liquidator's route is broken, as in "Aero failures") must not change
      // what the claim decides: a stake right after a claim still goes through under the window, a hard work inside the
      // window, whose claim is skipped, keeps the stake (leaving would forfeit all the stake earned since its last claim),
      // and the first hard work after the window, whose claim goes through, takes it out
      let universalLiquidator = await controller.universalLiquidator();
      let restaked;
      try {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        try {
          await controller.setUniversalLiquidator(farmer2, { from: governance }); // no code: every swap reverts
          try {
            // past the window and the stakeSpacing of the last stake, with new LP: the claim goes through, its sale fails as
            // a whole, and the stake right after the claim still goes through. The AERO claimed stays unsold, so the sales
            // below fail too
            await advanceToBlock(await nextStakeBlock());
            await depositVault(farmer2, underlying, vault, await farmer2LP(10));
            let block = await doHardWork();
            let claims = await gaugeEvents("EmissionsClaimed", block);
            assert.equal(claims.length, 1, "should claim outside the window");
            assert.equal((await strategyEvents("LiquidationFailed", block)).length, 1, "the sale should fail as a whole, without reverting");
            assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "the fee should be undone with the liquidation");
            assert.equal((await gaugeEvents("Deposit", block)).length, 1, "the stake right after a claim should go through while the liquidation fails");
            Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
            let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
            Utils.assertBNGte(aeroHeld, claims[0].args._rewardAmount.toString());
            let staked = new BigNumber(await gauge.balanceOf(strategy.address));

            // new LP, and governance keeps the LP unstaked while the stake is inside its window
            await depositVault(farmer2, underlying, vault, await farmer2LP(10));
            await setKeepUnstaked(true);

            // inside the window the claim is skipped and the sale of the AERO held fails as a whole again: the stake stays,
            // and the new LP waits unstaked
            let next = await doHardWork();
            assert.isBelow(next, block + 7, "should run inside the window");
            assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
            assert.equal((await strategyEvents("LiquidationFailed", next)).length, 1, "the sale of the AERO held should fail as a whole");
            assert.equal((await gaugeEvents("Withdraw", next)).length, 0, "a liquidation that fails as a whole should not take the stake out without a claim");
            assert.equal((await strategyEvents("UnstakedFromGauge", next)).length, 0);
            assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
            assert.equal((await forfeited(next)).length, 0, "nothing should be forfeited");
            assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake while kept unstaked");
            assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

            // the first hard work after the window claims, its sale fails as a whole once more, and it takes the whole stake
            // out right after the claim, with nothing left to forfeit
            await advanceToBlock(block + 6);
            let before = await gaugeCheckpoint();
            next = await doHardWork();
            assert.equal(next, block + 7, "should run at the first block after the window");
            claims = await gaugeEvents("EmissionsClaimed", next);
            assert.equal(claims.length, 1, "should claim");
            Utils.assertBNEq(claims[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
            assert.equal((await strategyEvents("LiquidationFailed", next)).length, 1, "the sale should fail as a whole");
            let withdrawn = await gaugeEvents("Withdraw", next);
            assert.equal(withdrawn.length, 1, "a liquidation that fails as a whole should not keep the stake in after a claim");
            Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
            let unstaked = await strategyEvents("UnstakedFromGauge", next);
            assert.equal(unstaked.length, 1);
            Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
            assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);
            assert.equal((await gaugeEvents("EmergencyWithdraw", next)).length, 0);
            assert.equal((await forfeited(next)).length, 0, "nothing should be forfeited");
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            assert.equal((await strategy.lastStakeBlock()).toString(), "0");
            assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake while kept unstaked");
            let skipped = await strategyEvents("StakeSkipped", next);
            assert.equal(skipped.length, 1);
            Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
            // nothing sold: the AERO waits for a working route
            Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), aeroHeld.plus(claims[0].args._rewardAmount.toString()));
          } finally {
            if (await strategy.keepUnstaked()) {
              await strategy.setKeepUnstaked(false, { from: governance });
            }
            await controller.setUniversalLiquidator(universalLiquidator, { from: governance });
          }
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        }
      } finally {
        // no window, the route back and keepUnstaked off: the next hard work sells the AERO kept and stakes all the LP at
        // once, also when a check above fails, so that the tests below find it staked
        restaked = await doHardWork();
      }
      await assertNoWindow();
      assert.equal((await strategyEvents("LiquidationFailed", restaked)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, restaked)).length, 1, "should sell the AERO kept");
      // neither pool token is AERO: a working route sells all of it
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await gaugeEvents("Deposit", restaked)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Keeps the stake while claims fail (minting paused, as in a shutdown), leaves through emergencyExit with the AERO deferred, then stakes nothing and still compounds pool fees", async function() {
      await mineBlocks(600); // AERO to claim
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      try {
        await setKeepUnstaked(true);
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          // the switch takes the stake out only right after a claim that goes through: while claims fail the hard work
          // keeps it, and the new LP waits unstaked
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          let lastStake = (await strategy.lastStakeBlock()).toString();
          assert.notEqual(lastStake, "0");
          let block = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "claim should fail without reverting");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0, "should not leave the gauge without a claim");
          assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake while kept unstaked");
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 1);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);

          // governance's emergency exit takes the stake out through the gauge's normal withdraw, which defers the AERO the
          // stake earned (minting is paused) instead of forfeiting it
          let tx = await strategy.emergencyExit({ from: governance });
          block = tx.receipt.blockNumber;
          let withdrawn = await gaugeEvents("Withdraw", block);
          assert.equal(withdrawn.length, 1, "should leave through the normal withdraw");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          let deferredEvents = await gaugeEvents("EmissionsDeferred", block);
          assert.equal(deferredEvents.length, 1, "the withdraw should defer the AERO");
          Utils.assertBNGt(deferredEvents[0].args._rewardAmount.toString(), 0);
          Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), deferredEvents[0].args._rewardAmount.toString());
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await forfeited(block)).length, 0, "nothing should be forfeited");
          assert.equal((await strategyEvents("GaugeExitFailed", block)).length, 0);
          assert.equal(await strategy.pausedInvesting(), true);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");

          // investing resumed, the hard works stake nothing, and still compound the pool fees the idle LP earns, while the
          // claim of the deferred AERO keeps failing
          await strategy.continueInvesting({ from: governance });
          for (let i = 0; i < 2; i++) {
            block = await compoundFeesUnstaked(await swapThroughPool());
            assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "the deferred AERO cannot be claimed yet");
          }
          Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), deferredEvents[0].args._rewardAmount.toString());
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }

        // once minting resumes, the next hard work collects the deferred AERO, and still stakes nothing
        let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
        let block = await doHardWork();
        let collected = await gaugeEvents("DeferredEmissionsClaimed", block);
        assert.equal(collected.length, 1, "should collect the deferred AERO");
        Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell it");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake while kept unstaked");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
        await strategy.setKeepUnstaked(false, { from: governance });
      }

      // switched off: the next hard work stakes all the LP at once
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Takes the stake out right after its claim and stakes no new LP when Aero switches the gauge off too, and still stakes none once governance switches keepUnstaked off", async function() {
      // keepUnstaked and Aero's switch-off (emission cap 0) each keep all the LP out of the gauge: both at once must too, the
      // stake taken out right after the claim, as with either alone
      await mineBlocks(600); // AERO to claim
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let restaked;
      try {
        await setKeepUnstaked(true);
        await setEmissionCap(0);
        try {
          Utils.assertBNEq(await gaugeFactory.emissionCap(gaugeAddress), 0);
          let unstakedBefore = await unstakedLP();
          let before = await gaugeCheckpoint();
          let block = await doHardWork();
          // the claim pays all the stake earned, so the exit right after it, through the gauge's normal withdraw, finds
          // nothing to forfeit
          let claimed = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(claimed.length, 1, "should claim");
          Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
          let withdrawn = await gaugeEvents("Withdraw", block);
          assert.equal(withdrawn.length, 1, "should take the stake out through the normal withdraw");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          let unstaked = await strategyEvents("UnstakedFromGauge", block);
          assert.equal(unstaked.length, 1, "should take the whole stake out right after the claim");
          Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          assert.equal((await forfeited(block)).length, 0, "nothing should be forfeited");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake");
          // all the LP waits in the strategy, the LP compounded from the claim with it
          let idle = new BigNumber(await underlying.balanceOf(strategy.address));
          Utils.assertBNEq(idle, unstakedBefore.plus(staked).plus(await mintedLP(block)));
          let skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
          await assertIdleLPCounted();

          // new LP, which the next hard work hands to the strategy, stays idle with the rest
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          let lp = await unstakedLP();
          block = await doHardWork();
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake the new LP");
          skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
          Utils.assertBNGte(skipped[0].args.idleAmount.toString(), lp);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);

          // governance switches keepUnstaked off: the gauge, still switched off by Aero, gets no LP either
          await setKeepUnstaked(false);
          block = await doHardWork();
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake in a switched-off gauge");
          skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        } finally {
          await setEmissionCap(cap);
        }
      } finally {
        if (await strategy.keepUnstaked()) {
          await strategy.setKeepUnstaked(false, { from: governance });
        }
        // both off: the next hard work stakes all the LP at once, also when a check above fails, so that the tests below
        // find it staked
        restaked = await doHardWork();
      }
      assert.equal((await gaugeEvents("Deposit", restaked)).length, 1, "should stake again");
      Utils.assertBNEq(await unstakedLP(), 0);
    });

    it("Leaves the gauge through emergencyWithdraw when its withdraw fails after the claim, and keeps the stake when Aero has not enabled it, with the claim, the fee and the compounding done", async function() {
      // kept unstaked, the exit after the claim is best effort, as from a gauge Aero switched off (cap 0; here Aero still
      // pays it): a gauge withdraw that fails right after the claim must not revert the hard work, which keeps its claim,
      // its fee and its compounding, and falls back to Aero's emergencyWithdraw when Aero has enabled it
      await mineBlocks(600); // AERO to claim
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let lastStake = (await strategy.lastStakeBlock()).toString();
      let restaked;
      try {
        await setKeepUnstaked(true);
        Utils.assertBNEq(await gaugeFactory.emissionCap(gaugeAddress), cap); // Aero has not switched the gauge off
        assert.equal(await gaugeFactory.emergencyWithdrawEnabled(), false, "Aero has not enabled emergencyWithdraw");

        // the gauge's withdraw fails right after the claim. With emergencyWithdraw disabled the exit fails too: the hard work
        // reports it, keeps the stake and goes on, with what it did before the exit done
        await withGaugeFailingAfterClaim(async () => {
          let block = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "the claim should go through");
          assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO sale and its fee should stay done");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "the compounding should stay done");
          Utils.assertBNGt(await mintedLP(block), 0);
          let failures = await strategyEvents("GaugeExitFailed", block);
          assert.equal(failures.length, 1, "the exit should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0);
          assert.equal((await gaugeEvents("EmergencyWithdraw", block)).length, 0);
          assert.equal((await strategyEvents("UnstakedFromGauge", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);
          // and it stakes nothing: the LP it compounded waits unstaked
          assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake while kept unstaked");
          let skipped = await strategyEvents("StakeSkipped", block);
          assert.equal(skipped.length, 1);
          Utils.assertBNEq(skipped[0].args.idleAmount.toString(), await underlying.balanceOf(strategy.address));
        });

        // enabled: the exit falls back to emergencyWithdraw. The stake first earns AERO to claim again
        await mineBlocks(600);
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        try {
          await withGaugeFailingAfterClaim(async () => {
            let before = await gaugeCheckpoint();
            let block = await doHardWork();
            // emergencyWithdraw does no emission accounting (V2Gauge.emergencyWithdraw): the claim right before it, in the
            // same transaction, paying everything the stake earned is what shows that nothing is lost
            let claimed = await gaugeEvents("EmissionsClaimed", block);
            assert.equal(claimed.length, 1, "the claim should go through");
            Utils.assertBNEq(claimed[0].args._rewardAmount.toString(), (await accruedSince(before)).plus(before.rewards));
            let exits = await gaugeEvents("EmergencyWithdraw", block);
            assert.equal(exits.length, 1, "should leave through emergencyWithdraw");
            Utils.assertBNEq(exits[0].args._amount.toString(), staked);
            let unstaked = await strategyEvents("UnstakedFromGauge", block);
            assert.equal(unstaked.length, 1);
            Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
            assert.equal((await strategyEvents("GaugeExitFailed", block)).length, 0);
            Utils.assertBNEq(await gauge.rewards(strategy.address), 0);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            assert.equal((await strategy.lastStakeBlock()).toString(), "0");
          });
        } finally {
          await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        }
      } finally {
        await strategy.setKeepUnstaked(false, { from: governance });
        // with the gauge working and keepUnstaked off, the next hard work stakes everything at once, also when a check above
        // fails, so that the tests below find it staked
        restaked = await doHardWork();
      }
      assert.equal((await gaugeEvents("Deposit", restaked)).length, 1, "should stake again");
      Utils.assertBNEq(await unstakedLP(), 0);
    });
  });

  describe("Minimum staking period over two stake cycles (1800 blocks)", function() {
    it("Skips claims only inside windows, stakes only after stakeSpacing, and loses only rewards earned inside windows", async function() {
      let windowBlocks = 1800; // an hour of Base blocks
      let keeperBlocks = 600; // a keeper run every 20 minutes
      let spacing = Number((await strategy.stakeSpacing()).toString());
      assert.equal(spacing, 10);
      let cycleRuns = spacing * windowBlocks / keeperBlocks; // 30 runs from one stake to the next
      let runs = 2 * cycleRuns + windowBlocks / keeperBlocks; // two full cycles, then the third window
      let previousWindow = (await gaugeFactory.effectivePenaltyConfig(gaugeAddress)).minStakeBlocks.toString();

      let stats = { inWindowRuns: 0, stakes: 0, fromIdle: 0, penalized: 0, outsideWindow: 0 };
      let claimed = new BigNumber(0); // by keeper runs, and by withdrawals outside windows
      let lost = new BigNumber(0);
      let earnedInWindows = new BigNumber(0);
      let lastStake;

      // a user withdrawal is always paid in full, from the vault and the idle LP first; one reaching the gauge inside a
      // window forfeits what the strategy earned since its last checkpoint, which is never older than the window
      async function withdraw(shares) {
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let available = new BigNumber(await vault.underlyingBalanceInVault()).plus(await underlying.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        let block = tx.receipt.blockNumber;
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let reachesGauge = expected.gt(available);
        assert.equal((await gaugeEvents("Withdraw", block)).length, reachesGauge ? 1 : 0,
          "only what the vault and the idle LP cannot pay should come from the gauge");
        let penalties = await gaugeEvents("EarlyWithdrawPenalty", block);
        let claims = await gaugeEvents("EmissionsClaimed", block);
        if (!reachesGauge) {
          stats.fromIdle++;
          assert.equal(penalties.length + claims.length, 0);
        } else if (block < lastStake + windowBlocks) {
          stats.penalized++;
          let earned = await accruedSince(before);
          assert.equal(penalties.length, 1, "should forfeit inside the window");
          Utils.assertBNEq(penalties[0].args._penalty.toString(), earned.plus(before.rewards));
          assert.equal(claims.length, 0, "a 100% penalty should leave nothing to claim");
          lost = lost.plus(penalties[0].args._penalty.toString());
          earnedInWindows = earnedInWindows.plus(earned);
        } else {
          stats.outsideWindow++;
          assert.equal(penalties.length, 0, "should not forfeit outside the window");
          assert.equal(claims.length, 1);
          claimed = claimed.plus(claims[0].args._rewardAmount.toString());
        }
      }

      // a clean start: everything back in the vault, plus most of farmer2's LP
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let newLP = new BigNumber(await underlying.balanceOf(farmer2)).times(3).div(4).integerValue(BigNumber.ROUND_DOWN);
      await depositVault(farmer2, underlying, vault, newLP.toFixed());
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, windowBlocks, { from: penaltyAdmin });
      try {
        // nothing is staked, so there is no window and no stakeSpacing to wait for
        let start = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", start)).length, 1, "the first run should stake");
        lastStake = start;
        let window = await strategy.penaltyWindow();
        assert.equal(window.minStakeBlocks.toString(), String(windowBlocks));
        assert.equal(window.windowEndBlock.toString(), String(start + windowBlocks));

        for (let k = 1; k <= runs; k++) {
          let target = start + k * keeperBlocks;
          let step = (k - 1) % cycleRuns; // 0: right after a stake; 0 to 2: inside its window

          // a user, halfway between two keeper runs
          await advanceToBlock(target - keeperBlocks / 2 - 1);
          let deposited = new BigNumber(0);
          if (step == 0) {
            // nothing is idle right after a stake: this reaches the gauge, inside the window
            await withdraw(new BigNumber(await vault.balanceOf(farmer2)).div(4).integerValue(BigNumber.ROUND_DOWN));
          } else if (step == 1 || step == 20) {
            deposited = new BigNumber(await farmer2LP(4));
            await depositVault(farmer2, underlying, vault, deposited.toFixed());
          } else if (step == 2) {
            // half of the idle LP: paid without touching the gauge
            let idle = new BigNumber(await underlying.balanceOf(strategy.address));
            await withdraw(idle.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment()));
          } else if (step == 14) {
            await withdraw(new BigNumber(await vault.balanceOf(farmer2)).div(2).integerValue(BigNumber.ROUND_DOWN));
          }

          // the keeper
          await advanceToBlock(target - 1);
          let inWindow = target < lastStake + windowBlocks;
          let windowEnd = target == lastStake + windowBlocks;
          // only stakeSpacing spaces the stakes: minStakeInterval (0 here, root before()) never comes later
          let stakeTime = target >= lastStake + spacing * windowBlocks;
          let before = await gaugeCheckpoint();
          let block = await doHardWork();
          assert.equal(block, target);
          let skippedClaims = await strategyEvents("ClaimSkipped", block);
          let claims = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(skippedClaims.length, inWindow ? 1 : 0, "should skip the claim inside the window only");
          assert.equal(claims.length, inWindow ? 0 : 1, "should claim outside the window");
          assert.equal((await gaugeEvents("EarlyWithdrawPenalty", block)).length, 0, "a keeper run should never forfeit rewards");
          assert.equal((await gaugeEvents("Deposit", block)).length, stakeTime ? 1 : 0, "should stake only after stakeSpacing");
          // the LP deposited meanwhile has moved on to the strategy, where it waits for the next stake
          Utils.assertBNEq(await vault.underlyingBalanceInVault(), 0);
          let idle = new BigNumber(await underlying.balanceOf(strategy.address));
          let skippedStakes = await strategyEvents("StakeSkipped", block);
          if (stakeTime) {
            Utils.assertBNEq(idle, 0);
            // the new window starts with nothing earned before it: the stake came right after the claim
            Utils.assertBNEq(await gauge.rewards(strategy.address), 0);
            lastStake = block;
            stats.stakes++;
          } else {
            Utils.assertBNGte(idle, deposited);
            assert.equal(skippedStakes.length, idle.gt(0) ? 1 : 0);
            if (idle.gt(0)) {
              Utils.assertBNEq(skippedStakes[0].args.idleAmount.toString(), idle);
              await assertIdleLPCounted(); // the waiting LP keeps its full value for the vault's users
            }
          }
          if (inWindow) {
            stats.inWindowRuns++;
            assert.equal(skippedClaims[0].args.windowEndBlock.toString(), String(lastStake + windowBlocks));
          } else {
            let amount = new BigNumber(claims[0].args._rewardAmount.toString());
            claimed = claimed.plus(amount);
            if (windowEnd) {
              // the first run after a window claims the rest of what the strategy earned inside it
              let earned = await accruedSince(before);
              Utils.assertBNEq(amount, earned.plus(before.rewards));
              earnedInWindows = earnedInWindows.plus(earned);
            }
          }
        }

        console.log("keeper runs: ", runs, " inside a window: ", stats.inWindowRuns, " (", (100 * stats.inWindowRuns / runs).toFixed(1), "%), stakes: ", stats.stakes);
        console.log("user withdrawals paid without the gauge: ", stats.fromIdle, " from the gauge inside a window: ", stats.penalized,
          " outside: ", stats.outsideWindow);
        console.log("AERO claimed: ", claimed.toFixed(), " lost: ", lost.toFixed(), " earned inside windows: ", earnedInWindows.toFixed());
        assert.equal(stats.stakes, 2, "should stake once per stakeSpacing");
        assert.equal(stats.inWindowRuns, 3 * (windowBlocks / keeperBlocks - 1));
        assert.equal(stats.penalized, 3, "the withdrawal right after each stake should reach the gauge inside the window");
        assert.isAbove(stats.fromIdle, 0);
        assert.isAbove(stats.outsideWindow, 0);
        Utils.assertBNGt(lost, 0);
        Utils.assertBNGte(earnedInWindows, lost); // never more than what was earned inside the windows
        // why a tenth: a withdrawal inside a window forfeits what the whole stake earned since that window opened (the
        // claim-then-stake that opened it paid out everything earned before), so the loss is at most what was earned inside
        // windows (above). Over the long run windows are one window length in every stakeSpacing (10); this run ends with
        // its third window, so 3 of its 21 window lengths are inside one, and about a seventh of the AERO was earned there.
        // And each withdrawal that reaches the gauge inside a window comes 300 blocks after the stake that opened it: it
        // forfeits what the stake earned in those first 300 of the window's 1800 blocks, and the rest is claimed when the
        // window ends. So about a sixth of a seventh of the AERO is lost here, well below a tenth
        Utils.assertBNGte(claimed.idiv(10), lost);
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
      }
    });
  });

  describe("Governance (7 blocks)", function() {
    before(async function() {
      // the stakes below open Aero's 7-block window, as in the settings tests
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
    });

    it("Lets only the strategy itself run liquidateRewards and compoundPoolTokens", async function() {
      // doHardWork and withdrawAllToVault call it on the strategy, so that its failures can be caught
      let message = await revertMessage(strategy.liquidateRewards({ from: governance }), "governance should not run liquidateRewards");
      assert.include(message, "Only self");
      message = await revertMessage(strategy.liquidateRewards({ from: farmer2 }), "an outsider should not run liquidateRewards");
      assert.include(message, "Only self");

      // liquidateRewards calls compoundPoolTokens on the strategy too, so that a failed compounding leaves the reward sale
      // and its fee done; nobody else may run it, with any reward token or reserve
      for (let [name, from] of [["governance", governance], ["an outsider", farmer2]]) {
        for (let [rewardToken, reserved] of [[aero, "0"], [usdc, "1"]]) {
          message = await revertMessage(strategy.compoundPoolTokens(rewardToken, reserved, { from: from }), name + " should not run compoundPoolTokens");
          assert.include(message, "Only self", name + " should be rejected");
        }
      }
    });

    it("Rejects an outsider on the hard work, every exit and every setting, so nobody can force a withdrawal inside the window", async function() {
      // right after a stake, inside its window: an exit now would forfeit what the stake earned since then
      let block = await claimThenStake(await farmer2LP(10));
      let staked = (await gauge.balanceOf(strategy.address)).toString();
      let window = await strategy.penaltyWindow();
      assert.equal(window.inWindow, true, "should be inside the window");

      // BaseUpgradeableStrategy restricted (vault, controller, governance) and GovernableInit onlyGovernance
      let restricted = "The sender has to be the controller, governance, or vault";
      let notGovernance = "Not governance";
      // first what would reach the gauge, each sent in its own block, all inside the window ...
      let exits = [
        ["withdrawToVault", () => strategy.withdrawToVault(staked, { from: farmer2 }), restricted],
        ["withdrawAllToVault", () => strategy.withdrawAllToVault({ from: farmer2 }), restricted],
        ["emergencyExit", () => strategy.emergencyExit({ from: farmer2 }), notGovernance],
        ["setGauge", () => strategy.setGauge(gaugeAddress, { from: farmer2 }), notGovernance],
        ["doHardWork", () => strategy.doHardWork({ from: farmer2 }), restricted],
      ];
      for (let [name, call, expected] of exits) {
        let message = await revertMessage(call(), "an outsider's " + name + " should revert");
        assert.include(message, expected, name + " should reject an outsider");
      }
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "the exits above should have been tried inside the window");
      // ... then the settings, the strategy's own and those it inherits (BaseUpgradeableStrategy, GovernableInit), all
      // onlyGovernance: setStorage would hand governance to another storage contract
      let governanceBefore = await strategy.governance(); // read through the storage contract
      let incentivesBefore = await strategy.incentives();
      let settings = [
        ["continueInvesting", () => strategy.continueInvesting({ from: farmer2 })],
        ["setSell", () => strategy.setSell(false, { from: farmer2 })],
        ["setMinStakeInterval", () => strategy.setMinStakeInterval(12960000, { from: farmer2 })],
        ["setKeepUnstaked", () => strategy.setKeepUnstaked(true, { from: farmer2 })],
        ["addRewardToken", () => strategy.addRewardToken(weth, { from: farmer2 })],
        ["removeRewardToken", () => strategy.removeRewardToken(weth, { from: farmer2 })],
        ["finalizeUpgrade", () => strategy.finalizeUpgrade({ from: farmer2 })],
        ["setStorage", () => strategy.setStorage(farmer2, { from: farmer2 })],
        ["setIncentives", () => strategy.setIncentives(farmer2, { from: farmer2 })],
        ["toggleMerklOperator", () => strategy.toggleMerklOperator(farmer2, farmer2, { from: farmer2 })],
      ];
      try {
        for (let [name, call] of settings) {
          let message = await revertMessage(call(), "an outsider's " + name + " should revert");
          assert.include(message, notGovernance, name + " should reject an outsider");
        }
      } finally {
        // should one of them let the outsider through, its setting goes back before the tests below run with it: a
        // minStakeInterval of 12,960,000 blocks would put every later stake ~13M blocks away
        if ((await strategy.minStakeInterval()).toString() != "0") {
          await strategy.setMinStakeInterval(0, { from: governance });
        }
        if (await strategy.keepUnstaked()) {
          await strategy.setKeepUnstaked(false, { from: governance });
        }
        if (!(await strategy.sell())) {
          await strategy.setSell(true, { from: governance });
        }
        if (await strategy.isRewardToken(weth)) {
          await strategy.removeRewardToken(weth, { from: governance });
        }
      }
      // nor can the live proxy be initialized again, with another vault or gauge (OpenZeppelin's initializer)
      let reinitializations = [
        ["initializeStrategy", () => strategy.initializeStrategy(addresses.Storage, farmer2, { from: farmer2 })],
        ["initializeBaseStrategy", () => strategy.initializeBaseStrategy(addresses.Storage, underlying.address, farmer2, gaugeAddress,
          aero, { from: farmer2 })],
      ];
      for (let [name, call] of reinitializations) {
        let message = await revertMessage(call(), "an outsider's " + name + " should revert");
        assert.include(message, "Initializable: contract is already initialized", name + " should be rejected");
      }

      // nothing changed: the stake, its deposit block and so its window, the strategy's settings; nothing reached the gauge
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
      assert.equal((await strategy.lastStakeBlock()).toString(), String(block));
      let after = await strategy.penaltyWindow();
      assert.equal(after.minStakeBlocks.toString(), window.minStakeBlocks.toString());
      assert.equal(after.penaltyRate.toString(), window.penaltyRate.toString());
      assert.equal(after.windowEndBlock.toString(), String(block + 7));
      assert.equal(await strategy.pausedInvesting(), false);
      assert.equal(await strategy.sell(), true);
      assert.equal((await strategy.minStakeInterval()).toString(), "0");
      assert.equal(await strategy.keepUnstaked(), false);
      assert.equal(await strategy.governance(), governanceBefore);
      assert.equal(await strategy.incentives(), incentivesBefore);
      assert.equal((await strategy.vault()).toLowerCase(), vault.address.toLowerCase());
      assert.deepEqual((await strategy.rewardTokens()).map(token => token.toLowerCase()), [aero.toLowerCase()]);
      assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
      for (let name of ["Deposit", "Withdraw", "EmissionsClaimed", "EarlyWithdrawPenalty", "EmergencyWithdraw"]) {
        let events = await gauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block + 1, toBlock: "latest" });
        assert.equal(events.length, 0, "an outsider should not reach the gauge: " + name);
      }
    });

    it("Keeps the claimed AERO while selling is off, and still stakes", async function() {
      let message = await revertMessage(strategy.setSell(false, { from: farmer2 }), "only governance should switch selling off");
      assert.include(message, "Not governance");

      await strategy.setSell(false, { from: governance });
      try {
        assert.equal(await strategy.sell(), false);
        // pool tokens in the strategy besides the AERO it is about to claim: the USDC behind a little of farmer2's LP
        let [usdcSent] = await burnLP(100);
        await usdcToken.transfer(strategy.address, usdcSent.toFixed(), { from: farmer2 });
        let held = await poolTokensHeld();
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        let block = await claimThenStake(newLP);
        let notCollected = await strategyEvents(profitsNotCollected, block);
        assert.equal(notCollected.length, 1, "should report the profits as not collected");
        assert.equal(notCollected[0].args.sell, false);
        // no fee and no swap: no AERO leaves the strategy, which keeps exactly what it claimed on top of what it had
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee");
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(aeroOut.length, 0, "should not sell any AERO");
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        Utils.assertBNGt(claimed, 0);
        Utils.assertBNEq(new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(aeroBefore), claimed);
        // the other pool tokens are compounded all the same: LP is minted from them and staked with the LP that was waiting
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        Utils.assertBNEq((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP).plus(minted));
        let leftover = await poolTokensHeld();
        console.log("pool tokens held ($, 18 decimals): ", held.toFixed(), " compounded into LP worth: ", (await lpDollars(minted)).toFixed(),
          " left over: ", leftover.toFixed());
        Utils.assertBNGt(held, leftover.times(100)); // leftover below 1%
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // selling is back on: the next hard work sells the kept AERO along with its claim, and compounds it
      assert.equal(await strategy.sell(), true);
      let kept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let lpBefore = await unstakedLP();
      let newLP = await farmer2LP(10);
      let block = await claimThenStake(newLP);
      let profits = await strategyEvents(profitLogInReward, block);
      assert.equal(profits.length, 1, "should take the fee again");
      let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
      Utils.assertBNGte(profits[0].args.profitAmount.toString(), kept.plus(claimed));
      Utils.assertBNGt((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP));
    });

    it("Sells an added reward token into AERO, and keeps compounding AERO while that token cannot be sold", async function() {
      // only governance manages the list, which never takes the underlying or a token twice
      let message = await revertMessage(strategy.addRewardToken(weth, { from: farmer2 }), "only governance should add a reward token");
      assert.include(message, "Not governance");
      message = await revertMessage(strategy.addRewardToken(underlying.address, { from: governance }), "the underlying should be rejected");
      assert.include(message, "Invalid reward token");
      message = await revertMessage(strategy.addRewardToken(aero, { from: governance }), "AERO is already a reward token");
      assert.include(message, "Invalid reward token");

      // the reward tokens, lowercased
      async function rewardTokens() {
        return (await strategy.rewardTokens()).map(token => token.toLowerCase());
      }

      let tx = await strategy.addRewardToken(weth, { from: governance });
      try {
        let added = await strategyEvents("RewardTokenAdded", tx.receipt.blockNumber);
        assert.equal(added.length, 1);
        assert.equal(added[0].args.token.toLowerCase(), weth);
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase(), weth]);
        message = await revertMessage(strategy.addRewardToken(weth, { from: governance }), "a token should not be added twice");
        assert.include(message, "Invalid reward token");

        // WETH reaches the strategy, but the liquidator has no route from WETH to AERO yet: only that swap fails ...
        let amount = "10000000000000000"; // 0.01 WETH
        await sendWETH(amount);
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        let block = await claimThenStake(newLP);
        let failures = await strategyEvents("LiquidationFailed", block);
        assert.equal(failures.length, 1, "only the WETH swap should fail");
        assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("PathsNotExist()"), "the liquidator's own error");
        Utils.assertBNEq(await wethToken.balanceOf(strategy.address), amount);
        Utils.assertBNEq(await wethToken.allowance(strategy.address, await controller.universalLiquidator()), 0);
        // ... and the AERO is still sold and compounded
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO should still be sold");
        Utils.assertBNGt((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP));

        // with a route on the Aero V2 dex (WETH -> USDC, then USDC -> AERO through the AERO/USDC pool), the next hard
        // work sells it into AERO before selling the AERO. The registry cannot remove a path: this one stays set for the
        // rest of the hardhat process, so also for any test file run after this one in the same process
        await universalLiquidatorRegistry.setPath(web3.utils.keccak256("aero"), [weth, usdc, aero], { from: addresses.ULOwner });
        block = await claimThenStake(await farmer2LP(10));
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        let wethOut = await wethToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(wethOut.length, 1, "should sell the WETH");
        Utils.assertBNEq(wethOut[0].args.value.toString(), amount);
        Utils.assertBNEq(await wethToken.balanceOf(strategy.address), 0);
        // the AERO it bought, paid by the AERO/USDC pool, is compounded along with the claim
        let bought = await aeroToken.getPastEvents("Transfer", { filter: { from: volatilePoolAddress, to: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(bought.length, 1, "the WETH should buy AERO");
        console.log("AERO bought with 0.01 WETH: ", bought[0].args.value.toString());
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        let profits = await strategyEvents(profitLogInReward, block);
        assert.equal(profits.length, 1);
        Utils.assertBNGte(profits[0].args.profitAmount.toString(), new BigNumber(bought[0].args.value.toString()).plus(claimed));
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "should compound the AERO sold");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the AERO sold");

        // with no WETH left, the next hard work (after the window, so that it claims) does not try to sell any
        await advanceToBlock(block + 7);
        block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "should skip a reward token it holds none of");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");

        // removing: never AERO, only a token in the list, only by governance
        message = await revertMessage(strategy.removeRewardToken(aero, { from: governance }), "AERO should not be removed");
        assert.include(message, "Invalid reward token");
        message = await revertMessage(strategy.removeRewardToken(usdc, { from: governance }), "a token not in the list should be rejected");
        assert.include(message, "Invalid reward token");
        message = await revertMessage(strategy.removeRewardToken(weth, { from: farmer2 }), "only governance should remove a reward token");
        assert.include(message, "Not governance");
        tx = await strategy.removeRewardToken(weth, { from: governance });
        let removed = await strategyEvents("RewardTokenRemoved", tx.receipt.blockNumber);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].args.token.toLowerCase(), weth);
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
      } finally {
        if (await strategy.isRewardToken(weth)) {
          await strategy.removeRewardToken(weth, { from: governance });
        }
      }
    });

    it("Removes any extra reward token, keeping the others in their order", async function() {
      // three extra reward tokens (Base ERC20s; no hard work runs while they are listed): WETH, cbBTC, DAI
      let cbbtc = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
      let dai = "0x50c5725949a6f0c72e6c4a641f24049a917db0cb";
      let extra = [weth.toLowerCase(), cbbtc, dai];
      async function rewardTokens() {
        return (await strategy.rewardTokens()).map(token => token.toLowerCase());
      }
      async function remove(token, expected) {
        let tx = await strategy.removeRewardToken(token, { from: governance });
        let removed = await strategyEvents("RewardTokenRemoved", tx.receipt.blockNumber);
        assert.equal(removed.length, 1);
        assert.equal(removed[0].args.token.toLowerCase(), token);
        assert.deepEqual(await rewardTokens(), expected);
        assert.equal(await strategy.isRewardToken(token), false);
      }

      assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
      try {
        for (let token of extra) {
          await strategy.addRewardToken(token, { from: governance });
        }
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase()].concat(extra));
        // from the middle: the tokens after it move up, in their order
        await remove(cbbtc, [aero.toLowerCase(), weth.toLowerCase(), dai]);
        await strategy.addRewardToken(cbbtc, { from: governance });
        assert.deepEqual(await rewardTokens(), [aero.toLowerCase(), weth.toLowerCase(), dai, cbbtc]);
        // the first extra token, then the last
        await remove(weth.toLowerCase(), [aero.toLowerCase(), dai, cbbtc]);
        await remove(cbbtc, [aero.toLowerCase(), dai]);
        await remove(dai, [aero.toLowerCase()]);
      } finally {
        for (let token of extra) {
          if (await strategy.isRewardToken(token)) {
            await strategy.removeRewardToken(token, { from: governance });
          }
        }
      }
      assert.deepEqual(await rewardTokens(), [aero.toLowerCase()]);
    });

    it("Salvages a token sent to it by mistake, but never the underlying or AERO, and only for governance", async function() {
      assert.equal(await strategy.unsalvagableTokens(underlying.address), true);
      assert.equal(await strategy.unsalvagableTokens(aero), true);
      assert.equal(await strategy.unsalvagableTokens(weth), false);
      for (let token of [underlying.address, aero]) {
        let message = await revertMessage(strategy.salvage(governance, token, 1, { from: governance }), "the underlying and AERO should never be salvaged");
        assert.include(message, "Token is non-salvageable");
      }

      let amount = "1000000000000000"; // 0.001 WETH
      await sendWETH(amount);
      let message = await revertMessage(strategy.salvage(farmer2, weth, amount, { from: farmer2 }), "only governance or the controller should salvage");
      assert.include(message, "The caller must be controller or governance");
      let strategyBefore = new BigNumber(await wethToken.balanceOf(strategy.address));
      let governanceBefore = new BigNumber(await wethToken.balanceOf(governance));
      await strategy.salvage(governance, weth, amount, { from: governance });
      Utils.assertBNEq(new BigNumber(await wethToken.balanceOf(governance)).minus(governanceBefore), amount);
      Utils.assertBNEq(await wethToken.balanceOf(strategy.address), strategyBefore.minus(amount));
    });

    it("Accepts a stakeSpacing from 1 to 1000 windows, from governance only", async function() {
      for (let invalid of [0, 1001]) {
        let message = await revertMessage(strategy.setStakeSpacing(invalid, { from: governance }), "a stakeSpacing out of range should be rejected");
        assert.include(message, "Invalid stake spacing");
      }
      let message = await revertMessage(strategy.setStakeSpacing(5, { from: farmer2 }), "only governance should set stakeSpacing");
      assert.include(message, "Not governance");
      assert.equal((await strategy.stakeSpacing()).toString(), "10", "rejected values should change nothing");

      try {
        for (let valid of [1, 1000]) {
          let tx = await strategy.setStakeSpacing(valid, { from: governance });
          let changed = await strategyEvents("StakeSpacingChanged", tx.receipt.blockNumber);
          assert.equal(changed.length, 1);
          assert.equal(changed[0].args.stakeSpacing.toString(), String(valid));
          assert.equal((await strategy.stakeSpacing()).toString(), String(valid));
        }
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
      }
    });

    it("Moves the stake only to a gauge of the same pool, even inside a window, and collects AERO deferred in the old gauge", async function() {
      let message = await revertMessage(strategy.setGauge(otherGaugeAddress, { from: governance }), "a gauge of another pool should be rejected");
      assert.include(message, "Underlying mismatch");
      message = await revertMessage(strategy.setGauge(gaugeAddress, { from: farmer2 }), "only governance should set the gauge");
      assert.include(message, "Not governance");

      // Aero has one gauge per pool, so the pool's own gauge stands in for the new one. The move unstakes everything
      // from the old gauge without waiting for the window (no exit does): it forfeits what the stake earned inside it
      let block = await claimThenStake(await farmer2LP(10));
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window");
      let idle = new BigNumber(await underlying.balanceOf(strategy.address));
      let before = await gaugeCheckpoint();
      let tx = await strategy.setGauge(gaugeAddress, { from: governance });
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "should unstake from the old gauge");
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), before.balance);
      let penalties = await gaugeEvents("EarlyWithdrawPenalty", tx.receipt.blockNumber);
      assert.equal(penalties.length, 1, "should forfeit inside the window");
      Utils.assertBNEq(penalties[0].args._penalty.toString(), (await accruedSince(before)).plus(before.rewards));
      let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
      assert.equal(changed.length, 1);
      assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal(changed[0].args.newGauge.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), idle.plus(before.balance));
      let window = await strategy.penaltyWindow();
      assert.equal(window.windowEndBlock.toString(), "0", "nothing staked: no window");
      assert.equal(window.inWindow, false);

      // the next hard work stakes into the new gauge: with nothing staked there is no window or stakeSpacing to wait for
      let next = await doHardWork();
      assert.isBelow(next, block + 7, "should run inside the old window");
      let deposits = await gaugeEvents("Deposit", next);
      assert.equal(deposits.length, 1, "should stake into the new gauge");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle.plus(before.balance));
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(next + 7));

      // AERO the old gauge deferred (minting paused at the last withdrawal), with nothing staked in it any more: the move
      // collects it, since no later claim from that gauge would
      await advanceToBlock(next + 7);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }); // outside the window: its AERO is deferred
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      tx = await strategy.setGauge(gaugeAddress, { from: governance });
      let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
      assert.equal(collected.length, 1, "should collect the deferred AERO from the old gauge");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await strategyEvents("GaugeChanged", tx.receipt.blockNumber)).length, 1);

      next = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake everything again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Moves to a second gauge of the pool, collecting the AERO deferred in the old one, then stakes there, and back", async function() {
      // Aero links one gauge to a pool (GaugeManager), but a gauge factory only checks that the GaugeManager calls it
      // (GaugeFactory.createGauge) and keys its gauges by pool alone: as the GaugeManager, the volatile gauges' factory
      // deploys a second gauge for this pool. The LeafVoter does not know it (settleGauge returns 0), so it pays no AERO.
      // The second gauge stays deployed for the rest of the hardhat process (the tests below reuse it): a second
      // createGauge for this pool would revert, since the factory deploys it with CREATE2 at the same address
      let otherFactory = new web3.eth.Contract(gaugeFactoryGovernanceAbi, otherGaugeFactoryAddress);
      assert.equal((await otherFactory.methods.GAUGE_MANAGER().call()).toLowerCase(), gaugeManagerAddress.toLowerCase());
      secondGaugeAddress = await otherFactory.methods.computeGaugeAddress(underlying.address).call();
      assert.equal(await web3.eth.getCode(secondGaugeAddress), "0x", "the pool should have no second gauge yet");
      let gaugeManagerEth = await web3.eth.getBalance(gaugeManagerAddress);
      await impersonates([gaugeManagerAddress]);
      await hre.network.provider.send("hardhat_setBalance", [gaugeManagerAddress, "0x8AC7230489E80000"]); // gas for its call
      try {
        await otherFactory.methods.createGauge(underlying.address, "0x").send({ from: gaugeManagerAddress });
      } finally {
        await hre.network.provider.send("hardhat_setBalance", [gaugeManagerAddress, web3.utils.toHex(gaugeManagerEth)]);
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [gaugeManagerAddress] });
      }
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      assert.notEqual(secondGaugeAddress.toLowerCase(), gaugeAddress.toLowerCase());
      assert.equal((await secondGauge.stakingToken()).toLowerCase(), underlying.address.toLowerCase());
      assert.equal((await secondGauge.gaugeFactory()).toLowerCase(), otherGaugeFactoryAddress.toLowerCase());
      Utils.assertBNGt(await (await IAeroV2GaugeFactory.at(otherGaugeFactoryAddress)).emissionCap(secondGaugeAddress), 0);

      // events the second gauge emitted for the strategy in `block`
      async function secondGaugeEvents(name, block) {
        return await secondGauge.getPastEvents(name, { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
      }

      // AERO deferred in the old gauge, with nothing staked in it any more: minting paused at the last withdrawal, which
      // came after the window, so that the AERO was deferred and not forfeited
      await advanceToBlock(Number((await gauge.depositBlock(strategy.address)).toString()) + 7);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);

      try {
        // the move collects that AERO from the old gauge, since no later claim from it would
        let tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
        let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
        assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
        let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(collected.length, 1, "should collect the deferred AERO from the old gauge");
        Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);

        // the next hard work stakes everything into the second gauge, nothing into the old one
        let lpBefore = await unstakedLP();
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake into the old gauge");
        let deposits = await secondGaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake into the second gauge");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lpBefore);
        let staked = new BigNumber(await secondGauge.balanceOf(strategy.address));
        Utils.assertBNEq(staked, deposits[0].args._amount.toString());
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await strategy.investedUnderlyingBalance(), staked);

        // and back to the pool's own gauge: the move unstakes everything from the second one
        tx = await strategy.setGauge(gaugeAddress, { from: governance });
        let withdrawn = await secondGaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1, "should unstake from the second gauge");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1);
        assert.equal(changed[0].args.oldGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal(changed[0].args.newGauge.toLowerCase(), gaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
        Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), staked);
      } finally {
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
      }

      // the next hard work stakes everything into the pool's own gauge again
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake into the pool's own gauge again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Never leaves its stake behind in an old gauge whose withdraw fails: the move reverts, and goes through after an emergency exit", async function() {
      // the pool's second gauge, deployed by the test above (a second createGauge for the pool would revert)
      assert.notEqual(await web3.eth.getCode(secondGaugeAddress), "0x");
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);

      try {
        await withLeafVoterCode(revertingCode, async () => {
          // every withdraw from the old gauge reverts while its LeafVoter is broken. With emergencyWithdraw disabled or
          // enabled, the move reverts with the old gauge's own error: it neither abandons the stake in a gauge the
          // strategy would no longer track, nor forfeits its AERO through emergencyWithdraw
          try {
            for (let enabled of [false, true]) {
              await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
              let message = await revertMessage(strategy.setGauge(secondGaugeAddress, { from: governance }),
                "the move should revert while the old gauge's withdraw fails (emergencyWithdraw enabled: " + enabled + ")");
              assert.include(message, revertData("0xdeadbeef"), "the move should revert with the old gauge's own error");
              assert.equal((await strategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase(), "the gauge should not change");
              Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
              Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
            }

            // the way out: an emergency exit, which leaves through emergencyWithdraw (enabled); the move then goes through
            // with nothing staked in the old gauge, whose failing claim does not block it
            let tx = await strategy.emergencyExit({ from: governance });
            let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
            assert.equal(exits.length, 1, "the emergency exit should leave through emergencyWithdraw");
            Utils.assertBNEq(exits[0].args._amount.toString(), staked);
            assert.equal(await strategy.pausedInvesting(), true);
            tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
            let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
            assert.equal(changed.length, 1);
            assert.equal(changed[0].args.oldGauge.toLowerCase(), gaugeAddress.toLowerCase());
            assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
            assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
          } finally {
            await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
          }
        });

        // with the LeafVoter back and investing resumed, the next hard work stakes everything into the new gauge at once
        await strategy.continueInvesting({ from: governance });
        let lp = await unstakedLP();
        let block = await doHardWork();
        let deposits = await secondGauge.getPastEvents("Deposit", { filter: { _account: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(deposits.length, 1, "should stake into the new gauge at once");
        Utils.assertBNGte(deposits[0].args._amount.toString(), lp);
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "should not stake into the old gauge");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
        // back in the pool's own gauge, a hard work stakes the LP there again: also after a failure above, which can leave
        // it idle since the emergency exit, so that the tests below find it staked
        if (new BigNumber(await underlying.balanceOf(strategy.address)).gt(0)) {
          await doHardWork();
        }
      }

      // everything staked in the pool's own gauge again
      Utils.assertBNGt(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await secondGauge.balanceOf(strategy.address), 0);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Moves the stake although the old gauge's claim fails (minting paused), and leaves the AERO deferred there to be claimed later", async function() {
      // the pool's second gauge, deployed by the test that moves the stake to it
      assert.notEqual(await web3.eth.getCode(secondGaugeAddress), "0x", "the pool's second gauge should be deployed");
      let secondGauge = await IAeroV2Gauge.at(secondGaugeAddress);
      // outside the window, so that the move's withdraw from the old gauge defers the stake's AERO instead of forfeiting it
      await advanceToBlock(Number((await gauge.depositBlock(strategy.address)).toString()) + 7);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);

      try {
        // minting paused through the whole move: its withdraw defers the AERO (V2Gauge._withdraw), then its claim of that
        // AERO from the old gauge reverts, which must not block the move
        let tx;
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          tx = await strategy.setGauge(secondGaugeAddress, { from: governance });
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
        let changed = await strategyEvents("GaugeChanged", tx.receipt.blockNumber);
        assert.equal(changed.length, 1, "the move should go through");
        assert.equal(changed[0].args.newGauge.toLowerCase(), secondGaugeAddress.toLowerCase());
        assert.equal((await strategy.rewardPool()).toLowerCase(), secondGaugeAddress.toLowerCase());
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1);
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        let deferredEvents = await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber);
        assert.equal(deferredEvents.length, 1, "the withdraw should defer the AERO");
        assert.equal((await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber)).length, 0, "the claim should have failed");
        // the failed claim left the deferred AERO as the withdraw recorded it
        let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
        Utils.assertBNGt(deferred, 0);
        Utils.assertBNEq(deferred, deferredEvents[0].args._rewardAmount.toString());

        // the strategy stakes into the new gauge, and the AERO waits in the old one
        let block = await doHardWork();
        assert.equal((await secondGauge.getPastEvents("Deposit", { filter: { _account: strategy.address }, fromBlock: block, toBlock: block })).length, 1,
          "should stake into the new gauge");
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), deferred);
      } finally {
        if ((await strategy.rewardPool()).toLowerCase() != gaugeAddress.toLowerCase()) {
          await strategy.setGauge(gaugeAddress, { from: governance });
        }
      }

      // back in the old gauge, its next claim collects that AERO
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      let block = await doHardWork();
      let collected = await gaugeEvents("DeferredEmissionsClaimed", block);
      assert.equal(collected.length, 1, "the deferred AERO should be claimed later");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake into the pool's own gauge again");
    });

    it("Keeps its state and its window through an upgrade, which only governance can complete after the delay", async function() {
      let proxy = await StrategyProxy.at(strategy.address);
      let newImplementation = await Strategy.new();
      let message = await revertMessage(strategy.scheduleUpgrade(newImplementation.address, { from: farmer2 }), "only governance should schedule an upgrade");
      assert.include(message, "Not governance");
      await strategy.scheduleUpgrade(newImplementation.address, { from: governance });
      assert.equal(await strategy.nextImplementation(), newImplementation.address);
      message = await revertMessage(proxy.upgrade({ from: governance }), "the upgrade should wait for the delay");
      assert.include(message, "Upgrade not scheduled");
      await Utils.waitHours(13); // the controller's nextImplementationDelay is 12 hours

      // carried over: a stake inside its window, and a stakeSpacing and a minStakeInterval other than the defaults (an
      // interval of 30 blocks, shorter than the 84 blocks of stakeSpacing, changes no stake below), keepUnstaked
      // switched on (until the window ends: inside it the stake stays either way), and what a failed compounding recorded
      // as fee-paid (the stake's own hard work, with the pool's mint failing): nothing here, since that hard work sold all
      // its AERO, neither pool token being AERO
      await strategy.setStakeSpacing(12, { from: governance });
      await strategy.setMinStakeInterval(30, { from: governance });
      try {
        let block = await withPoolMintFailing(async () => await claimThenStake(await farmer2LP(10)));
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the stake's hard work should fail to compound");
        let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
        Utils.assertBNEq(aeroKept, 0);
        await strategy.setKeepUnstaked(true, { from: governance });
        // finalizeUpgrade runs with the caller's address: an upgrade by anyone but governance reverts as a whole
        message = await revertMessage(proxy.upgrade({ from: farmer2 }), "only governance should complete the upgrade");
        assert.include(message, "Issue when finalizing the upgrade");

        // the strategy's storage, its stake and its window
        async function snapshot() {
          let window = await strategy.penaltyWindow();
          return {
            underlying: await strategy.underlying(),
            vault: await strategy.vault(),
            rewardPool: await strategy.rewardPool(),
            rewardTokens: (await strategy.rewardTokens()).join(),
            strategist: await strategy.strategist(),
            sell: await strategy.sell(),
            pausedInvesting: await strategy.pausedInvesting(),
            stakeSpacing: (await strategy.stakeSpacing()).toString(),
            minStakeInterval: (await strategy.minStakeInterval()).toString(),
            lastStakeBlock: (await strategy.lastStakeBlock()).toString(),
            keepUnstaked: await strategy.keepUnstaked(),
            feePaidReward: (await strategy.feePaidReward()).toString(),
            staked: (await gauge.balanceOf(strategy.address)).toString(),
            invested: (await strategy.investedUnderlyingBalance()).toString(),
            window: [window.minStakeBlocks.toString(), window.penaltyRate.toString(), window.windowEndBlock.toString(), window.inWindow].join(),
          };
        }
        let before = await snapshot();
        assert.equal(before.window, ["7", "1000000", String(block + 7), true].join());
        assert.equal(before.minStakeInterval, "30");
        assert.equal(before.lastStakeBlock, String(block));
        assert.equal(before.keepUnstaked, true);
        // all the AERO held is what the failed compounding kept, whose fee it took: none here
        assert.equal(before.feePaidReward, aeroKept.toFixed(), "the AERO kept should be recorded as fee-paid");
        await proxy.upgrade({ from: governance });
        assert.equal(await proxy.implementation(), newImplementation.address);
        assert.equal(await strategy.nextImplementation(), zeroAddress, "finalizeUpgrade should clear the schedule");
        assert.equal((await strategy.nextImplementationTimestamp()).toString(), "0");
        assert.deepEqual(await snapshot(), before);

        // the upgraded strategy follows the same rules: it skips inside the window (where kept unstaked or not, it cannot
        // leave the gauge without a claim), and stakes 12 windows after the last stake
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("Withdraw", next)).length, 0, "should not leave the gauge without a claim");
        assert.equal(await nextStakeBlock(), block + 84);
        // and it compounds the pool tokens the failed compounding left, taking no fee: neither pool token is AERO, so its
        // pool fee claim brought no AERO, and it holds none
        let charged = (await strategyEvents(profitLogInReward, next)).reduce((total, profit) => total.plus(profit.args.profitAmount.toString()), new BigNumber(0));
        console.log("after the upgrade: AERO carried over as fee-paid ", aeroKept.toFixed(), ", fee base ", charged.toFixed());
        assert.equal((await strategyEvents(profitLogInReward, next)).length, 0, "should take no fee: it holds no AERO and its claim was skipped");
        assert.equal((await poolEvents("Mint", next, strategy.address)).length, 1, "should compound the pool tokens left");
        assert.equal((await strategy.feePaidReward()).toString(), "0", "a compounding that goes through should clear feePaidReward");
        await strategy.setKeepUnstaked(false, { from: governance });
        // where the default stakeSpacing (10 windows) would stake, it claims and still waits: it uses the stored 12
        await advanceToBlock(block + 69);
        next = await doHardWork();
        assert.equal(next, block + 70);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake at the default stakeSpacing");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        next = await claimThenStake(await farmer2LP(10));
        assert.isAtLeast(next, block + 84);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      } finally {
        await strategy.setStakeSpacing(10, { from: governance });
        await strategy.setMinStakeInterval(0, { from: governance });
        if (await strategy.keepUnstaked()) {
          await strategy.setKeepUnstaked(false, { from: governance });
        }
      }
    });
  });

  describe("Aero failures", function() {
    before(async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      await assertNoWindow();
      await Utils.advanceNBlock(10);
      await doHardWork(); // everything staked
    });

    it("Keeps working while Aero's minting is paused, and claims the deferred AERO later", async function() {
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      let paused = false;
      try {
        // past the window and the stakeSpacing of the before hook's stake, so only the failed claim can block a stake
        let nextStakeBlock = Number((await gauge.depositBlock(strategy.address)).toString())
          + Number((await strategy.stakeSpacing()).toString()) * 7;
        await advanceToBlock(nextStakeBlock);
        // and new LP to stake: little, so that farmer1's withdrawal below still reaches the gauge
        let newLP = new BigNumber(await underlying.balanceOf(farmer1)).div(100).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, newLP.toFixed());
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        paused = true;
        assert.equal((await strategy.penaltyWindow()).inWindow, false, "should be outside the window");

        let block = await doHardWork();
        assert.isAtLeast(block, nextStakeBlock, "should be past stakeSpacing, so only the failed claim can block the stake");
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "claim should fail without reverting");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 1, "no stake without a claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0, "no stake without a claim");
        // the new LP waits, unstaked, in the strategy
        Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);

        // a withdrawal reaching the gauge still pays in full; its rewards are deferred, not lost
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
        assert.equal((await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber)).length, 1);
        Utils.assertBNGt(await gauge.deferredEmissions(strategy.address), 0);

        // so does withdrawAll (also used by rebalance and migration): claiming the deferred AERO fails, without reverting
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        Utils.assertBNGt(await gauge.deferredEmissions(strategy.address), 0);

        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        paused = false;
        block = await doHardWork();
        assert.equal((await gaugeEvents("DeferredEmissionsClaimed", block)).length, 1, "deferred AERO should be claimed");
        Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "the LP should be staked again");
      } finally {
        if (paused) {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin });
        }
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Never lets a broken liquidation route block claiming, staking or exits", async function() {
      await Utils.advanceNBlock(1800);
      let universalLiquidator = await controller.universalLiquidator();
      await controller.setUniversalLiquidator(farmer2, { from: governance }); // no code: every swap reverts
      try {
        // new LP for the hard work to stake
        let newLP = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, newLP.toFixed());
        let block = await doHardWork();
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 1);
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should still claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "a broken route should not block staking");
        // the liquidateRewards self-call reverts as a whole (its try/catch in doHardWork): no fee is taken and the AERO
        // stays in the strategy; since neither pool token is AERO, a working route must sell all of it (checked below)
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), claimed[0].args._rewardAmount.toString());

        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await strategyEvents("LiquidationFailed", tx.receipt.blockNumber)).length, 1);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      } finally {
        await controller.setUniversalLiquidator(universalLiquidator, { from: governance });
      }

      // once the route is back, all the AERO is sold (none goes into the pool as is) and the LP staked again
      Utils.assertBNGt(await aeroToken.balanceOf(strategy.address), 0);
      let block = await doHardWork();
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1);
    });

    it("Reverts the hard work, claim included, when its liquidation fails Aero's gas check, while withdrawAll completes without it", async function() {
      // Aero's pool tape gas check (in every swap: PoolFactory.recordPoolTape) fails the swaps through this pool as if the
      // keeper had sent too little gas. Unlike a broken route (above), the hard work reverts with InsufficientGasForCall,
      // so that the keeper retries with more gas instead of claiming and leaving the AERO unsold
      await Utils.advanceNBlock(1800);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let before = await gaugeCheckpoint();
      let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
      await withPoolTapeFailing(poolFactory.address, async () => {
        let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
          "the hard work should revert when its liquidation fails Aero's gas check");
        assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid); // nothing claimed
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // withdrawAll (also used by rebalance and migration) is never retried by a keeper: it goes on without the
        // liquidation, hands all the LP to the vault and keeps the claimed AERO for a later hard work
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let failures = await strategyEvents("LiquidationFailed", tx.receipt.blockNumber);
        assert.equal(failures.length, 1, "the liquidation should fail without reverting withdrawAll");
        assert.equal(failures[0].args.reason, insufficientGasError, "Aero's gas check error");
        let claimed = await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber);
        assert.equal(claimed.length, 1);
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), aero.plus(claimed[0].args._rewardAmount.toString()));
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      });

      // with Aero's gas limit back, the next hard work sells the AERO kept and stakes everything
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO kept");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1);
    });

    it("Reverts the hard work when an added reward token's sale fails Aero's gas check", async function() {
      // WETH is sold into AERO through the volatile pools (WETH/USDC, USDC/AERO: the path set by the reward token test).
      // The AERO sale also goes through the volatile AERO/USDC pool, so with the volatile pools' tape failing this runs
      // with no AERO to sell: right after withdrawAll, with nothing staked (nothing to claim) and the AERO sold. The zap
      // only uses this vault's stable pool, whose tape works
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      Utils.assertBNGt(new BigNumber("10000000000000"), await aeroToken.balanceOf(strategy.address)); // below MIN_REWARD
      let amount = "10000000000000000"; // 0.01 WETH
      await sendWETH(amount);
      await strategy.addRewardToken(weth, { from: governance });
      try {
        await withPoolTapeFailing(volatilePoolFactory, async () => {
          let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
            "the hard work should revert when the reward token's sale fails Aero's gas check");
          assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
          Utils.assertBNEq(await wethToken.balanceOf(strategy.address), amount);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        });

        // with Aero's gas limit back, the hard work sells the WETH into AERO, the AERO into the pool, and stakes
        let lpBefore = await unstakedLP();
        let block = await doHardWork();
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        let wethOut = await wethToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(wethOut.length, 1, "should sell the WETH");
        Utils.assertBNEq(wethOut[0].args.value.toString(), amount);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO it bought");
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "should put the AERO into the pool");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should put the AERO into the pool");
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1);
        Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore.plus(minted));
      } finally {
        if (await strategy.isRewardToken(weth)) {
          await strategy.removeRewardToken(weth, { from: governance });
        }
      }
    });

    it("Rolls back the whole liquidation when only the USDC -> alUSDb leg is broken", async function() {
      // stable pool only: the second leg sells USDC for alUSDb through this vault's own pool. The test setup routes it
      // on the UniversalLiquidator's Aero V2 dex; unset only that pair, as it is on chain before the setup
      let dex = await IAeroV2Dex.at(aeroV2Dex);
      await Utils.advanceNBlock(1800);
      await dex.pairSetup(usdc, alusdb, zeroAddress, { from: addresses.ULOwner });
      try {
        assert.equal(await dex.factory(usdc, alusdb), zeroAddress);
        assert.equal((await dex.factory(aero, usdc)).toLowerCase(), volatilePoolFactory.toLowerCase(), "the AERO -> USDC leg should still work");
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));

        let block = await doHardWork();
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 1);
        let claimed = await gaugeEvents("EmissionsClaimed", block);
        assert.equal(claimed.length, 1, "should still claim");
        // the AERO -> USDC swap and the fee run before the broken leg, and are undone with it: no AERO left the strategy
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(aeroOut.length, 0, "the liquidation should be rolled back as a whole");
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), claimed[0].args._rewardAmount.toString());
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
      } finally {
        await dex.pairSetup(usdc, alusdb, stablePoolFactory, { from: addresses.ULOwner });
      }

      // with the leg back, all the AERO is sold
      assert.equal((await dex.factory(usdc, alusdb)).toLowerCase(), stablePoolFactory.toLowerCase());
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      // the Transfer query used above does see AERO leaving the strategy when the liquidation goes through
      let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
      assert.isAbove(aeroOut.length, 0);
    });

    it("Never sends AERO dust into the liquidation, and sells it with the next claim", async function() {
      // stable pool only: neither pool token is AERO, so every liquidation sells all of it and the strategy can be left
      // with dust alone; the volatile strategy keeps AERO from its pool's ratio, always above the dust threshold
      await Utils.advanceNBlock(600);
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }); // sells all the AERO; nothing stays staked
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);

      // farmer2 buys a little AERO with WETH through the liquidator, and sends the strategy a tenth of MIN_REWARD (1e13).
      // The registry cannot remove a path: this one stays set for the rest of the hardhat process, so also for any test
      // file run after this one in the same process
      await universalLiquidatorRegistry.setPath(web3.utils.keccak256("aero"), [weth, usdc, aero], { from: addresses.ULOwner });
      let universalLiquidator = await IUniversalLiquidator.at(await controller.universalLiquidator());
      let wethAmount = "1000000000000000"; // 0.001 WETH
      await (await IWETH.at(weth)).deposit({ from: farmer2, value: wethAmount });
      await wethToken.approve(universalLiquidator.address, wethAmount, { from: farmer2 });
      await universalLiquidator.swap(weth, aero, wethAmount, 1, farmer2, { from: farmer2, gasPrice: keeperGasPrice });
      let dust = "1000000000000";
      await aeroToken.transfer(strategy.address, dust, { from: farmer2 });

      // nothing was staked, so nothing is claimed: the hard work keeps the dust (no fee, no swap, no mint) and stakes. It
      // may still compound the pool tokens it holds besides (pool fees, trim leftovers): only the AERO is reserved
      let lpBefore = await unstakedLP();
      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should not sell dust");
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
      assert.equal(aeroOut.length, 0, "no AERO should leave the strategy");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake");
      Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore.plus(await mintedLP(block)));

      // the next claim makes it worth selling: all the AERO goes, the dust with it
      await Utils.advanceNBlock(600);
      block = await doHardWork();
      let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
      let profits = await strategyEvents(profitLogInReward, block);
      assert.equal(profits.length, 1, "should sell the AERO");
      Utils.assertBNEq(profits[0].args.profitAmount.toString(), new BigNumber(claimed).plus(dust));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
    });

    it("Takes the fee on AERO just above the dust threshold, but never swaps or mints with what the fee leaves", async function() {
      // AERO in [MIN_REWARD, MIN_REWARD / (1 - f)), f the share the RewardForwarder pulls as fees (profit sharing and
      // platform; notifyFee ignores the strategist fee): enough for the fee (the MIN_REWARD check before
      // _notifyProfitInRewardToken), dust after it (the MIN_REWARD check before _swapRewardIntoPoolTokens)
      let minReward = new BigNumber("10000000000000"); // AerodromeV2Strategy MIN_REWARD (1e13)
      let denominator = new BigNumber(await controller.feeDenominator());
      let profitSharing = new BigNumber(await controller.profitSharingNumerator());
      let platform = new BigNumber(await controller.platformFeeNumerator());
      let feeOf = (amount) => amount.times(profitSharing).idiv(denominator).plus(amount.times(platform).idiv(denominator));
      let amount = minReward.plus(minReward.times(denominator).idiv(denominator.minus(profitSharing).minus(platform))).idiv(2);
      console.log("fee numerators (profit sharing, platform, strategist) and denominator: ", profitSharing.toFixed(), platform.toFixed(),
        (await controller.strategistFeeNumerator()).toString(), denominator.toFixed(), " AERO sent: ", amount.toFixed());
      Utils.assertBNGt(feeOf(amount), 0);
      Utils.assertBNGt(minReward, amount.minus(feeOf(amount))); // what the fee leaves is dust

      // nothing staked, so the hard work below claims nothing; and no AERO left in the strategy, as in the test above
      await Utils.advanceNBlock(600);
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      // farmer2 still holds most of the AERO it bought in the test above
      Utils.assertBNGte(await aeroToken.balanceOf(farmer2), amount);
      await aeroToken.transfer(strategy.address, amount.toFixed(), { from: farmer2 });
      let lpBefore = await unstakedLP();
      let dust = amount.minus(feeOf(amount));
      // for the second hard work below: USDC from a little of farmer2's LP, and a 7-block window, which the stake of the
      // first one opens, so that the second one runs inside it, without a claim
      let usdcIn = (await burnLP(1000))[0];
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        // the hard work takes the fee on that AERO, and keeps the rest
        let block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0, "nothing staked: nothing to claim");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        let profits = await strategyEvents(profitLogInReward, block);
        assert.equal(profits.length, 1, "should take the fee");
        Utils.assertBNEq(profits[0].args.profitAmount.toString(), amount);
        // the fee is the only AERO that leaves the strategy: nothing is swapped
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(aeroOut.length, 1, "only the fee should leave the strategy, no AERO should be swapped");
        assert.equal(aeroOut[0].args.to.toLowerCase(), (await controller.rewardForwarder()).toLowerCase());
        Utils.assertBNEq(aeroOut[0].args.value.toString(), feeOf(amount));
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
        // and no LP is minted from that AERO: the stake is the LP that was already waiting in the vault and the strategy,
        // and what the other pool tokens it held (pool fees from withdrawAll's own swaps) compounded into
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake");
        Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore.plus(await mintedLP(block)));

        // the next hard work, inside the window that stake opened, claims nothing: the strategy holds the dust alone, and
        // the USDC farmer2 sends. It takes no fee on the dust and leaves it as it is, while it zaps the USDC into LP
        await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "the claim should wait for the window");
        assert.equal((await strategyEvents(profitLogInReward, next)).length, 0, "should take no fee on dust");
        assert.equal((await strategyEvents("LiquidationFailed", next)).length, 0);
        let zap = await poolEvents("Swap", next, strategy.address);
        assert.equal(zap.length, 1, "the zap should swap USDC through the pool");
        Utils.assertBNGt(zap[0].returnValues.amount0In, 0);
        Utils.assertBNEq(zap[0].returnValues.amount1In, 0);
        assert.equal((await poolEvents("Mint", next, strategy.address)).length, 1, "should mint LP from the USDC");
        let minted = await mintedLP(next);
        Utils.assertBNGt(minted, 0);
        // AERO is not a pool token here: none of it moves
        aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: next, toBlock: next });
        assert.equal(aeroOut.length, 0, "the dust should stay in the strategy");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
        // the new LP waits for the window to pass
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), idleBefore.plus(minted));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Falls back to emergencyWithdraw only in an emergency exit, when the gauge withdraw is broken and Aero enabled it", async function() {
      // every gauge withdraw reverts while Aero's LeafVoter is broken: every call to it reverts with 0xdeadbeef
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
      try {
        await withLeafVoterCode(revertingCode, async () => {
          // emergencyWithdraw disabled: emergencyExit still pauses without reverting, and reports the gauge's error; a
          // user withdrawal reaching the gauge reverts with it
          let tx = await strategy.emergencyExit({ from: governance });
          let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
          assert.equal(exitFailures.length, 1);
          assert.equal(exitFailures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          await strategy.continueInvesting({ from: governance });
          let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert while the gauge is broken");
          assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge's own error");

          // Aero enables emergencyWithdraw on the gauge's factory: a user withdrawal still reverts with the gauge's own
          // error, since leaving through emergencyWithdraw forfeits the stake's unclaimed AERO: governance's call ...
          await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
          message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert, not fall back to emergencyWithdraw");
          assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge's own error");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

          // ... through emergencyExit, which falls back to it
          tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "emergencyExit should fall back to emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");

          // users are paid in full again, from the LP now idle in the strategy
          let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
          let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
          tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
          Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
          assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });

    it("Never mistakes a gas failure for an Aero failure", async function() {
      await doHardWork(); // stake again
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);

      // emergencyWithdraw is available, but every gauge call now fails Aero's gas check (InsufficientGasForCall),
      // exactly like a call sent with too little gas: that must be re-raised, never routed to emergencyWithdraw
      let gaugeTape = await gaugeFactory.gaugeTape();
      let gaugeTapeGasLimit = await gaugeFactory.gaugeTapeGasLimit();
      assert.notEqual(gaugeTape, zeroAddress, "the gas check only runs with a gauge tape");
      try {
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        await gaugeFactory.setGaugeTape(gaugeTape, "4000000000", { from: penaltyAdmin });

        // user exits call the gauge with no gas floor of their own: they revert with the gauge's InsufficientGasForCall
        let insufficientGas = revertData(insufficientGasError);
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }),
          "withdrawal should revert, not fall back to emergencyWithdraw");
        assert.include(message, insufficientGas, "the withdrawal should revert with Aero's gas check error");
        message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }),
          "withdrawAll should revert, not fall back to emergencyWithdraw");
        assert.include(message, insufficientGas, "withdrawAll should revert with Aero's gas check error");
        // the emergency exit's floor (gaugeTapeGasLimit + 1,200,000 gas left) is out of reach: it reverts before the gauge
        message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert, not silently keep the stake");
        assert.include(message, "Not enough gas for the gauge", "emergencyExit should revert before calling the gauge");
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

        // with the gas limit restored, the same withdrawal uses the normal withdraw although emergencyWithdraw is enabled
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        assert.equal(await gaugeFactory.emergencyWithdrawEnabled(), true);
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 1);
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0, "emergencyWithdraw is only a fallback");
      } finally {
        // restore Aero (and investing, had emergencyExit gone through)
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });

    it("Reverts the hard work when the claim fails Aero's gas check, and goes on when the claim fails otherwise", async function() {
      // the claim's InsufficientGasForCall comes here from a LeafVoter that returns nothing else (the gauge passes its
      // revert data through), as from a gauge tape needing more gas than the keeper left. With the default
      // minStakeInterval the hard work stakes nothing, so the claim is the only gauge call that could fail
      await doHardWork(); // everything staked
      await Utils.advanceNBlock(600);
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      let before = await gaugeCheckpoint();
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        await withLeafVoterCode(insufficientGasCode, async () => {
          let message = await revertMessage(gauge.claimEmissions.call(strategy.address, strategy.address, { from: strategy.address }),
            "the gauge's claim should revert");
          assert.include(message, revertData(insufficientGasError), "the gauge should pass its LeafVoter's revert data through");
          message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
            "the hard work should revert when its claim fails Aero's gas check");
          assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
        });
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // any other claim failure (here Aero's minting paused) is reported, and the hard work goes on
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          let block = await doHardWork();
          let failures = await strategyEvents("ClaimFailed", block);
          assert.equal(failures.length, 1, "the claim should fail without reverting");
          assert.notEqual(failures[0].args.reason, insufficientGasError);
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }
    });

    it("Keeps new LP unstaked, with no allowance left to the gauge, when the gauge deposit fails", async function() {
      // gauge.deposit settles the gauge with the LeafVoter first (V2Gauge _deposit -> _updateRewards -> _advanceRewards),
      // so every deposit reverts while the LeafVoter is broken. With no window a stake does not need the claim
      await assertNoWindow();
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
      let idle;
      try {
        let block = await doHardWork();
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "the claim should fail without reverting");
        let failures = await strategyEvents("StakeFailed", block);
        assert.equal(failures.length, 1, "the stake should fail without reverting");
        assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        // the LP waits in the strategy, and the gauge is left no allowance to pull it later
        idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await underlying.allowance(strategy.address, gaugeAddress), 0);
      } finally {
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
      }

      // with the LeafVoter back, the next hard work stakes the waiting LP
      let block = await doHardWork();
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake once the gauge works again");
      Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Keeps new LP unstaked, with no allowance left, when the deposit right after a claim fails under a window, and stakes it on the next run", async function() {
      // under a window a stake needs the claim to go through first (_stakeIdle's window gate): here the claim goes through
      // and the gauge deposit right after it fails, with an Aero error that is not its gas check (that one reverts the
      // whole hard work: next test). Both settle the gauge with the LeafVoter first (V2Gauge._advanceRewards), and the
      // LeafVoter fails every settlement after the first of a transaction (laterSettleRevertsCode)
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      let idle;
      try {
        // past the window and the stakeSpacing of the last stake, with new LP: only the deposit can keep it unstaked
        await advanceToBlock(await nextStakeBlock());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let depositBlock = Number((await gauge.depositBlock(strategy.address)).toString());
        let lastStake = (await strategy.lastStakeBlock()).toString();
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));

        await withGaugeFailingAfterClaim(async () => {
          let block = await doHardWork();
          // the claim goes through ...
          assert.equal((await strategyEvents("ClaimFailed", block)).length, 0, "the claim should go through");
          assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
          assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "the claim and stakeSpacing should allow the stake");
          // ... the deposit after the liquidation does not, and fails without reverting
          let failures = await strategyEvents("StakeFailed", block);
          assert.equal(failures.length, 1, "the stake should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
          assert.equal((await gaugeEvents("Deposit", block)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        });
        // the LP waits in the strategy, and the gauge is left no allowance to pull it later
        idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await underlying.allowance(strategy.address, gaugeAddress), 0);
        // no new window and no new last stake: the next run need not wait for stakeSpacing again
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(depositBlock));
        assert.equal((await strategy.lastStakeBlock()).toString(), lastStake);
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(depositBlock + 7));
        assert.equal(window.inWindow, false, "should be outside the window");

        // with the LeafVoter back, the next hard work claims and stakes the waiting LP at once
        let block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake the waiting LP");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(block + 7));
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Reverts the whole hard work, claim included, when the deposit after the claim fails Aero's gas check, and claims and stakes with more keeper gas", async function() {
      // Aero's gas check (recordGaugeTape reverts InsufficientGasForCall while gasleft() <= gaugeTapeGasLimit, in
      // GaugeFactory._validateGasLeft) runs in both the claim and the deposit (V2Gauge._advanceRewards), with the
      // liquidation in between: for a fixed keeper gas limit, a tape gas limit between the gas left at the claim and the gas
      // left at the deposit passes the claim and fails the deposit. At this point of the suite (fork block 53206000, this
      // test order), with 4,000,000 keeper gas, these were 3,316,839 and 1,977,481 (bisecting the tape gas limit with
      // calls; the liquidation swaps twice and zaps here): 2,650,000 is ~670,000 from both. The deposit's gas failure reverts
      // the whole hard work (_revertOnGasFailure), so that the keeper retries with more gas
      let keeperGas = 4000000;
      let tapeGasLimit = 2650000;
      let gaugeTape = await gaugeFactory.gaugeTape();
      let gaugeTapeGasLimit = await gaugeFactory.gaugeTapeGasLimit();
      assert.notEqual(gaugeTape, zeroAddress, "the gas check only runs with a gauge tape");
      let hardWorkCall = { from: governance, to: controller.address, gas: keeperGas, gasPrice: keeperGasPrice,
        data: controller.contract.methods.doHardWork(vault.address).encodeABI() };
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      try {
        // past the window and the stakeSpacing of the last stake, with new LP: the hard work claims, and stakes
        await advanceToBlock(await nextStakeBlock());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        let before = await gaugeCheckpoint();
        let aero = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let unstaked = await unstakedLP();
        Utils.assertBNGt(unstaked, 0);
        await gaugeFactory.setGaugeTape(gaugeTape, tapeGasLimit, { from: penaltyAdmin });

        // the claim passes the check at this limit: with the stake left out (the default minStakeInterval), the same hard
        // work goes through (a call: nothing changes)
        await strategy.setMinStakeInterval(432000, { from: governance });
        try {
          await web3.eth.call(hardWorkCall);
        } catch (e) {
          assert.fail("the claim should pass Aero's gas check at this limit: re-bisect tapeGasLimit, see the comment above (" + e.message + ")");
        } finally {
          await strategy.setMinStakeInterval(0, { from: governance });
        }

        // with the stake, the deposit after the liquidation fails the check: the whole hard work reverts
        let outcome = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: keeperGas })
          .then((tx) => tx, (e) => e);
        if (!(outcome instanceof Error)) {
          // it went through: the deposit's gas failure was reported instead of re-raised, or the tape gas limit no longer
          // sits between the gas left at the claim and the gas left at the deposit
          let failures = await strategyEvents("StakeFailed", outcome.receipt.blockNumber);
          assert.equal(failures.length, 0, "the deposit's gas failure should revert the hard work, not be reported: StakeFailed("
            + (failures.length > 0 ? failures[0].args.reason : "") + ")");
          assert.fail("the deposit should fail Aero's gas check at this limit: re-bisect tapeGasLimit, see the comment above");
        }
        assert.include(outcome.message, revertData(insufficientGasError),
          "the hard work should revert with Aero's gas check error: re-bisect tapeGasLimit, see the comment above");
        // and changes nothing: no claim (the AERO is still in the gauge), the LP still waits in the vault
        Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid);
        Utils.assertBNEq(await gauge.rewards(strategy.address), before.rewards);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aero);
        Utils.assertBNEq(await unstakedLP(), unstaked);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the same hard work with more keeper gas claims and stakes
        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: 2 * keeperGas });
        let block = tx.receipt.blockNumber;
        console.log("keeper gas limit: ", 2 * keeperGas, " tape gas limit: ", tapeGasLimit, " (Aero's: ", gaugeTapeGasLimit.toString(),
          ") gas used: ", tx.receipt.gasUsed);
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake");
        Utils.assertBNGte(deposits[0].args._amount.toString(), unstaked);
        Utils.assertBNEq(await unstakedLP(), 0);
      } finally {
        // restore Aero
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
      }
      await assertNoWindow();
    });

    it("Keeps going when the pool's fee claim fails, in the hard work and in withdrawAll", async function() {
      // the pool pays its fees out of its fee holder (Pool.sol _claimFees -> PoolFees.claimFeesFor), while swaps only
      // send tokens to it: a broken fee holder breaks claimFees for an LP owed fees, and nothing else
      let poolFees = await poolFeeAccounting.methods.poolFees().call();

      // the strategy earns pool fees on the LP it holds unstaked: withdrawAll's liquidation swaps through this pool (the
      // USDC -> alUSDb leg of the AERO sale, and the zap) while all the LP is out of the gauge, and claims fees before
      // that, so it leaves the strategy owed fees
      await Utils.advanceNBlock(3600);
      await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let pending = await pendingFees();
      console.log("pool fees owed to the strategy (token0, token1): ", pending.amount0, pending.amount1);
      Utils.assertBNGt(new BigNumber(pending.amount0).plus(pending.amount1), 0);

      let poolFeesCode = await web3.eth.getCode(poolFees);
      await hre.network.provider.send("hardhat_setCode", [poolFees, revertingCode]);
      try {
        let message = await revertMessage(poolFeeAccounting.methods.claimFees(strategy.address).call({ from: strategy.address }),
          "the strategy's fee claim should revert");
        assert.include(message, revertData("0xdeadbeef"), "with the fee holder's error");

        // the hard works go on: the first stakes the LP back, the next claims, sells through the pool, compounds and stakes
        let block = await doHardWork();
        assert.equal((await feeClaims(block)).length, 0, "the fee claim should fail without reverting");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");
        await Utils.advanceNBlock(600);
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        await depositVault(farmer2, underlying, vault, newLP);
        block = await doHardWork();
        assert.equal((await feeClaims(block)).length, 0, "the fee claim should fail without reverting");
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "swaps should not need the fee holder");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake");
        Utils.assertBNGt(deposits[0].args._amount.toString(), lpBefore.plus(newLP)); // with LP minted from the AERO

        // and withdrawAll empties the gauge
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await feeClaims(tx.receipt.blockNumber)).length, 0, "the fee claim should fail without reverting");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        // the fees owed were never paid, and only grew with the strategy's own sales
        let owed = await pendingFees();
        Utils.assertBNGte(owed.amount0, pending.amount0);
        Utils.assertBNGte(owed.amount1, pending.amount1);
      } finally {
        await hre.network.provider.send("hardhat_setCode", [poolFees, poolFeesCode]);
      }

      // so with the fee holder back, the next hard work collects them all, and stakes the LP again
      pending = await pendingFees();
      let block = await doHardWork();
      let claims = await feeClaims(block);
      assert.equal(claims.length, 1, "should claim the fees");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Collects in the next withdrawAll the pool fees that its own sale in the last one earned", async function() {
      // withdrawAll claims the pool fees before its liquidation swaps through this pool (the USDC -> alUSDb leg of the AERO
      // sale, and the zap) while it holds all the LP unstaked: the fees of these swaps stay owed to the strategy (two hours
      // of AERO, so that its share of these fees, tiny at this stable pool's 0.05%, is not zero)
      await Utils.advanceNBlock(3600);
      let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 1, "the withdrawal should claim");
      assert.equal((await strategyEvents(profitLogInReward, tx.receipt.blockNumber)).length, 1, "should sell the AERO");
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      let pending = await pendingFees();
      console.log("pool fees owed to the strategy after withdrawAll (token0, token1): ", pending.amount0, pending.amount1);
      Utils.assertBNGt(new BigNumber(pending.amount0).plus(pending.amount1), 0);

      // the next withdrawAll, with nothing staked, claims them, compounds them into LP and hands that LP to the vault with
      // the rest. The strategy holds no LP during that zap, so it is owed nothing afterwards
      let vaultLP = new BigNumber(await vault.underlyingBalanceInVault());
      tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let claims = await feeClaims(tx.receipt.blockNumber);
      assert.equal(claims.length, 1, "withdrawAll should claim the fees owed");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
      let minted = await mintedLP(tx.receipt.blockNumber);
      Utils.assertBNGt(minted, 0);
      Utils.assertBNEq(await vault.underlyingBalanceInVault(), vaultLP.plus(minted));
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
      let owed = await pendingFees();
      Utils.assertBNEq(new BigNumber(owed.amount0).plus(owed.amount1), 0);

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Collects in the next withdrawAll, with nothing staked, the AERO that a failed mint deferred", async function() {
      // a withdrawAll while Aero's minting is paused defers the AERO (V2Gauge _withdraw), and its own claim fails
      await Utils.advanceNBlock(600);
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await gaugeEvents("EmissionsDeferred", tx.receipt.blockNumber)).length, 1, "the withdrawal should defer the AERO");
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let deferred = new BigNumber(await gauge.deferredEmissions(strategy.address));
      Utils.assertBNGt(deferred, 0);
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);

      // with nothing staked there is no window and nothing to unstake: the next withdrawAll claims it itself (its claim
      // after the unstake) and sells it
      let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "nothing should be left to unstake");
      let collected = await gaugeEvents("DeferredEmissionsClaimed", tx.receipt.blockNumber);
      assert.equal(collected.length, 1, "withdrawAll should collect the deferred AERO");
      Utils.assertBNEq(collected[0].args._amount.toString(), deferred);
      Utils.assertBNEq(await gauge.deferredEmissions(strategy.address), 0);
      assert.equal((await strategyEvents(profitLogInReward, tx.receipt.blockNumber)).length, 1, "should sell the AERO");

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
    });

    it("Empties the gauge into the vault, when the gauge withdraw is broken, only after an emergency exit through emergencyWithdraw", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      try {
        await withLeafVoterCode(revertingCode, async () => {
          // withdrawAll (also used by rebalance and migration) reverts with the gauge's error, with emergencyWithdraw
          // disabled and enabled alike: it never forfeits the stake's AERO on its own
          for (let enabled of [false, true]) {
            await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
            let message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }),
              "withdrawAll should revert while the gauge is broken (emergencyWithdraw enabled: " + enabled + ")");
            assert.include(message, revertData("0xdeadbeef"), "withdrawAll should revert with the gauge's own error");
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          }

          // the way out: governance's emergency exit leaves through emergencyWithdraw (enabled) ...
          let tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should exit through emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal(await strategy.pausedInvesting(), true);
          // ... then withdrawAll hands all the LP to the vault; its claim fails without reverting
          let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
          tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
          assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "claiming needs the LeafVoter");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      // with the gauge working again, the next hard work stakes everything
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Reports emergencyWithdraw's own error when that fails too in an emergency exit, and still pauses; users get the gauge withdraw's error", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      // emergencyWithdraw does no emission accounting (V2Gauge.emergencyWithdraw), so it can only fail at the LP transfer:
      // here the gauge has lost its LP (moved away by impersonating the gauge), while withdraw fails first, on the LeafVoter
      let gaugeLP = new BigNumber(await underlying.balanceOf(gaugeAddress));
      let gaugeEth = await web3.eth.getBalance(gaugeAddress);
      let lpHolder = accounts[8];
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      let moved = false;
      await impersonates([gaugeAddress]);
      await hre.network.provider.send("hardhat_setBalance", [gaugeAddress, "0x8AC7230489E80000"]); // gas for its transfer
      try {
        await underlying.transfer(lpHolder, gaugeLP.toFixed(), { from: gaugeAddress });
        moved = true;
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        // the pool's (OpenZeppelin ERC20) error for a gauge holding no LP
        let insufficientBalance = (amount) => web3.eth.abi.encodeFunctionSignature("ERC20InsufficientBalance(address,uint256,uint256)")
          + web3.eth.abi.encodeParameters(["address", "uint256", "uint256"], [gaugeAddress, 0, amount]).slice(2);

        // a user withdrawal reaching the gauge reverts with the gauge withdraw's error (0xdeadbeef): users never fall back
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert while the gauge is broken");
        assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge withdraw's own error");

        // an emergency exit falls back, still pauses investing, and reports emergencyWithdraw's error; the stake stays in
        // the gauge's books
        let tx = await strategy.emergencyExit({ from: governance });
        let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
        assert.equal(exitFailures.length, 1);
        assert.equal(exitFailures[0].args.reason, insufficientBalance(stakedBefore.toFixed()), "should report emergencyWithdraw's error");
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        assert.notEqual((await strategy.lastStakeBlock()).toString(), "0", "the stake is still there");
      } finally {
        // restore Aero (and investing)
        if (moved) {
          await underlying.transfer(gaugeAddress, gaugeLP.toFixed(), { from: lpHolder });
        }
        await hre.network.provider.send("hardhat_setBalance", [gaugeAddress, web3.utils.toHex(gaugeEth)]);
        await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [gaugeAddress] });
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
      Utils.assertBNEq(await underlying.balanceOf(gaugeAddress), gaugeLP);
    });

    it("Treats a gauge failure without revert data like any other: users get it, an emergency exit reports it or falls back to emergencyWithdraw", async function() {
      // only Aero's own gas check error (InsufficientGasForCall) is re-raised as a gas failure: empty revert data is not.
      // Here every call to the LeafVoter reverts with no data, without burning its gas
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
      try {
        await withLeafVoterCode(emptyRevertCode, async () => {
          // user withdrawals and withdrawAll revert with the gauge's (empty) revert data, emergencyWithdraw enabled or not
          for (let enabled of [false, true]) {
            await gaugeFactory.setEmergencyWithdrawEnabled(enabled, { from: emergencyWithdrawAdmin });
            let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert");
            assert.include(message, "Transaction reverted without a reason string", "the withdrawal should revert with no data, as the gauge did");
            message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }), "withdrawAll should revert");
            assert.include(message, "Transaction reverted without a reason string", "withdrawAll should revert with no data, as the gauge did");
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          }

          // emergencyWithdraw disabled: the emergency exit reports the failure, with no data, and still pauses
          await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
          let tx = await strategy.emergencyExit({ from: governance });
          let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
          assert.equal(exitFailures.length, 1, "the exit should fail without reverting");
          assert.include([null, "0x"], exitFailures[0].args.reason, "the gauge's own (empty) revert data");
          assert.equal(await strategy.pausedInvesting(), true);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
          await strategy.continueInvesting({ from: governance });

          // enabled: it falls back to emergencyWithdraw
          await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
          tx = await strategy.emergencyExit({ from: governance });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should fall back to emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        });
      } finally {
        // restore Aero (the LeafVoter's code is back) and investing
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Pays a user withdrawal from the gauge with far less gas than an emergency exit needs: user exits have no gas floor", async function() {
      // only the best-effort exits (emergencyExit, and the hard work's exit from a gauge Aero switched off or while
      // keepUnstaked is on) need gaugeTapeGasLimit + 1,200,000 gas left before calling the gauge; a user withdrawal calls
      // its withdraw directly, which needs a few hundred thousand
      Utils.assertBNEq(await unstakedLP(), 0); // everything staked: the withdrawal reaches the gauge
      let floor = await exitGasFloor();
      assert.isBelow(900000, floor);
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
      let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
      let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
      let tx = await vault.withdraw(shares.toFixed(), { from: farmer1, gas: 900000 });
      console.log("gas used by a user withdrawal from the gauge: ", tx.receipt.gasUsed, " (exit floor: ", floor, ")");
      Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
      let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
      assert.equal(withdrawn.length, 1, "the withdrawal should reach the gauge's normal withdraw");
      Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected);
      assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0);
    });

    it("Refuses an emergency exit with too little gas left for the gauge, and just above that leaves through the normal withdraw", async function() {
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let floor = await exitGasFloor();
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        // the floor counts the gas left when the exit starts: a transaction with only that much gas has less by then
        let message = await revertMessage(strategy.emergencyExit({ from: governance, gas: floor }), "emergencyExit should revert below the floor");
        assert.include(message, "Not enough gas for the gauge");
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

        // the least gas that gets through lands just above the floor: the gauge's withdraw then gets all but the 200,000 kept
        // back, plenty for it, so the exit leaves through it, although emergencyWithdraw is enabled
        let least = await leastGas({ from: governance, to: strategy.address, data: strategy.contract.methods.emergencyExit().encodeABI() },
          floor, floor + 1000000);
        console.log("least gas for emergencyExit: ", least, " exit floor: ", floor);
        assert.isBelow(least, floor + 150000, "the least gas should be set by the floor");
        let tx = await strategy.emergencyExit({ from: governance, gas: least });
        let withdrawn = await gaugeEvents("Withdraw", tx.receipt.blockNumber);
        assert.equal(withdrawn.length, 1, "should leave through the normal withdraw");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 0, "emergencyWithdraw is only a fallback");
        assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
        assert.equal(await strategy.pausedInvesting(), true);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Leaves through emergencyWithdraw in an emergency exit when the gauge withdraw burns all its gas, while user exits revert", async function() {
      // a gauge withdraw that runs out of gas: the LeafVoter hits INVALID, which burns all the gas the gauge passed on
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let floor = await exitGasFloor();
      let shares = new BigNumber(await vault.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        await withLeafVoterCode(invalidCode, async () => {
          // user exits revert, emergencyWithdraw is not theirs to use
          let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert");
          assert.include(message, "Transaction reverted without a reason string");
          message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }), "withdrawAll should revert");
          assert.include(message, "Transaction reverted without a reason string");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);

          // an emergency exit with only 200,000 gas more than the floor still gets out: the withdraw burns all the gas it was
          // given, but that was all but the 200,000 kept back for emergencyWithdraw
          let tx = await strategy.emergencyExit({ from: governance, gas: floor + 200000 });
          let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
          assert.equal(exits.length, 1, "should leave through emergencyWithdraw");
          Utils.assertBNEq(exits[0].args._amount.toString(), staked);
          assert.equal((await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber)).length, 0);
          assert.equal(await strategy.pausedInvesting(), true);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal((await strategy.lastStakeBlock()).toString(), "0");

          // then withdrawAll hands all the LP to the vault. Its claim burns 63/64 of the gas it gets too, so it is sent with
          // ample gas
          let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
          await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice, gas: 8000000 });
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
        });
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
    });

    it("Re-raises Aero's gas check error from the gauge withdraw in an emergency exit, even with emergencyWithdraw enabled", async function() {
      // InsufficientGasForCall says the gauge needed more gas: more gas fixes it, so it never justifies forfeiting the
      // stake's AERO through emergencyWithdraw. It comes here from a LeafVoter that returns nothing else
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
      try {
        await withLeafVoterCode(insufficientGasCode, async () => {
          // the gauge's withdraw passes the LeafVoter's revert data through
          let message = await revertMessage(gauge.withdraw.call(staked.toFixed(), { from: strategy.address }), "the gauge's withdraw should revert");
          assert.include(message, revertData(insufficientGasError));
          message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert");
          assert.include(message, revertData(insufficientGasError), "emergencyExit should re-raise Aero's gas check error");
        });
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
      } finally {
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
    });
  });

  describe("Pool tokens compounded through the zap (no window)", function() {
    before(async function() {
      await assertNoWindow();
      await doHardWork(); // everything staked
    });

    // the AERO the hard work in `block` brought in: its claim (neither pool token is AERO: its pool fee claims pay none)
    async function newAero(block) {
      return (await gaugeEvents("EmissionsClaimed", block)).reduce((total, claim) => total.plus(claim.args._rewardAmount.toString()), new BigNumber(0));
    }

    // the AERO the hard work in `block` took the fee on (its one ProfitLogInReward)
    async function feeBase(block) {
      let profits = await strategyEvents(profitLogInReward, block);
      assert.equal(profits.length, 1, "should take the fee once");
      return new BigNumber(profits[0].args.profitAmount.toString());
    }

    async function feePaidReward() {
      return new BigNumber(await strategy.feePaidReward());
    }

    // the slot of feePaidReward (keccak256("eip1967.strategyStorage.feePaidReward") - 1), which the stale-value tests write
    // in the strategy's storage: the proxy's, strategy.address
    let feePaidRewardSlot = "0x" + web3.utils.toBN(web3.utils.keccak256("eip1967.strategyStorage.feePaidReward")).subn(1).toString(16).padStart(64, "0");

    async function writeFeePaidReward(value) {
      await hre.network.provider.send("hardhat_setStorageAt", [strategy.address, feePaidRewardSlot, "0x" + new BigNumber(value).toString(16).padStart(64, "0")]);
    }

    // makes sure farmer2 holds `amount` of AERO to send the strategy. Neither pool token is AERO, so farmer2's LP holds
    // none: its AERO comes from the AERO dust test of "Aero failures", which buys some with WETH through the liquidator.
    // Without that test (this describe run on its own) farmer2 buys it here the same way, and the path it sets stays set,
    // as there
    async function farmer2Aero(amount) {
      if (new BigNumber(await aeroToken.balanceOf(farmer2)).lt(amount)) {
        await universalLiquidatorRegistry.setPath(web3.utils.keccak256("aero"), [weth, usdc, aero], { from: addresses.ULOwner });
        let universalLiquidator = await IUniversalLiquidator.at(await controller.universalLiquidator());
        let wethAmount = "1000000000000000"; // 0.001 WETH, as in that test
        await (await IWETH.at(weth)).deposit({ from: farmer2, value: wethAmount });
        await wethToken.approve(universalLiquidator.address, wethAmount, { from: farmer2 });
        await universalLiquidator.swap(weth, aero, wethAmount, 1, farmer2, { from: farmer2, gasPrice: keeperGasPrice });
      }
      Utils.assertBNGte(await aeroToken.balanceOf(farmer2), amount);
    }

    it("Swaps a surplus of either pool token for the other through the pool, then mints, leaving almost nothing", async function() {
      // selling off: the hard work claims AERO but neither sells it nor puts it in the pool, and still compounds the pool
      // tokens the strategy holds: here one of them only, the USDC (token0), then the alUSDb (token1) behind 0.05% of
      // farmer2's LP (a few dollars: the zap prices its swap at the pool's margin, so its error grows with the size)
      await strategy.setSell(false, { from: governance });
      try {
        for (let [name, index] of [["USDC (token0)", 0], ["alUSDb (token1)", 1]]) {
          let amounts = await burnLP(2000);
          await (await IERC20.at(index == 0 ? usdc : alusdb)).transfer(strategy.address, amounts[index].toFixed(), { from: farmer2 });
          let held = await poolTokensHeld();
          let block = await doHardWork();
          // the zap swaps part of the surplus for the other token through the pool ...
          let zap = await poolEvents("Swap", block, strategy.address);
          assert.equal(zap.length, 1, "the zap should swap " + name + " through the pool");
          let swap = zap[0].returnValues;
          if (index == 0) {
            Utils.assertBNGt(swap.amount0In, 0);
            Utils.assertBNEq(swap.amount1In, 0);
            Utils.assertBNGt(swap.amount1Out, 0);
          } else {
            Utils.assertBNGt(swap.amount1In, 0);
            Utils.assertBNEq(swap.amount0In, 0);
            Utils.assertBNGt(swap.amount0Out, 0);
          }
          // ... then mints LP with both, which is staked
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1);
          let minted = await mintedLP(block);
          Utils.assertBNGt(minted, 0);
          assert.equal((await gaugeEvents("Deposit", block)).length, 1);
          let leftover = await poolTokensHeld();
          console.log("zap of ", name, ": held ($, 18 decimals): ", held.toFixed(), " swapped: ", (await dollars(swap.amount0In, swap.amount1In)).toFixed(),
            " minted LP worth: ", (await lpDollars(minted)).toFixed(), " left over: ", leftover.toFixed(), " (", leftover.toNumber() / held.toNumber(), ")");
          // what is left is a few USDC wei, about a millionth of what was held here (~5 millionths with a single probe): the
          // zap's own swap shifts the pool's ratio by about (amount swapped / its reserve) + (amount bought / its reserve),
          // which leaves that share of what it bought unpaired. A single probe adds only ~4e-6 on this pool (~8 USDC wei
          // here), and that leftover grows past it at a few times this size, so unlike the volatile suite's, no bound here
          // tells it apart. Pricing the swap of a token1 surplus with token0's probe (the zap before the fix) under-swaps by
          // about the pool's fee: ~6 ten-thousandths left over here
          Utils.assertBNGt(held, leftover.times(20000));
        }
      } finally {
        await strategy.setSell(true, { from: governance });
      }
    });

    it("Mints what is in the pool's ratio while Aero has paused swaps, zaps the rest once they resume, and keeps the AERO a paused sale cannot sell", async function() {
      await strategy.setSell(false, { from: governance });
      try {
        // pool tokens in the pool's ratio (all those behind 0.1% of farmer2's LP), and as much USDC again
        let amounts = await burnLP(1000);
        await usdcToken.transfer(strategy.address, amounts[0].toFixed(), { from: farmer2 });
        await alusdbToken.transfer(strategy.address, amounts[1].toFixed(), { from: farmer2 });
        let surplus = (await burnLP(1000))[0];
        await usdcToken.transfer(strategy.address, surplus.toFixed(), { from: farmer2 });

        await withSwapsPaused(async () => {
          let block = await doHardWork();
          // no swap through the paused pool (Pool.swap would revert IsPaused and fail the compounding: CompoundFailed,
          // nothing minted) ...
          assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the zap should not swap while swaps are paused");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          // the zap skips its swap: trying it would fail the compounding
          assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "the zap should skip its swap while swaps are paused");
          // ... but the part in the pool's ratio is minted (Pool.mint has no pause check) and staked; the surplus waits
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint what is in the pool's ratio");
          Utils.assertBNGt(await mintedLP(block), 0);
          let left = new BigNumber(await usdcToken.balanceOf(strategy.address));
          console.log("USDC surplus: ", surplus.toFixed(), " left while swaps are paused: ", left.toFixed());
          Utils.assertBNGte(left, surplus.times(99).idiv(100));
          Utils.assertBNGte(surplus.times(101).idiv(100), left);
        });

        // once swaps resume, the next hard work zaps the rest
        let block = await doHardWork();
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "should zap the surplus");
        Utils.assertBNGt(zap[0].returnValues.amount0In, 0);
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1);
        Utils.assertBNGt(await dollars(surplus, 0), (await poolTokensHeld()).times(1000));
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // with selling on, the hard work's AERO sale goes through this pool too (USDC -> alUSDb, the route of the test setup):
      // while swaps are paused that sale reverts IsPaused, and the whole liquidation with it, fee included. The AERO waits
      await Utils.advanceNBlock(600);
      await withSwapsPaused(async () => {
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let block = await doHardWork();
        let failures = await strategyEvents("LiquidationFailed", block);
        assert.equal(failures.length, 1, "the AERO sale should fail");
        assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("IsPaused()"), "the pool's own error");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "no fee should be taken");
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(claimed));
      });
      // and is sold with the next claim once swaps resume
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1);
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
    });

    it("Leaves nothing behind in withdrawAll: the pool fees owed and the pool tokens held go to the vault as LP", async function() {
      let aeroLeft;
      // LP idle in the strategy earns pool fees: the default minStakeInterval keeps new LP out of the gauge
      await strategy.setMinStakeInterval(432000, { from: governance });
      try {
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let block = await doHardWork();
        assert.equal((await gaugeEvents("Deposit", block)).length, 0);
        Utils.assertBNGt(await underlying.balanceOf(strategy.address), 0);
        // swaps through the pool, and pool tokens sent to the strategy
        let amounts = await burnLP(100);
        await poolSwap(farmer2, usdc, amounts[0].toFixed());
        await poolSwap(farmer2, alusdb, amounts[1].toFixed());
        let pending = await pendingFees();
        Utils.assertBNGt(await dollars(pending.amount0, pending.amount1), 0);
        let sent = (await burnLP(1000))[0];
        await usdcToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
        let held = (await poolTokensHeld()).plus(await dollars(pending.amount0, pending.amount1));

        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let claims = await feeClaims(tx.receipt.blockNumber);
        assert.equal(claims.length, 1, "should claim the pool fees");
        Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
        Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
        let minted = await mintedLP(tx.receipt.blockNumber);
        Utils.assertBNGt(minted, 0);
        // all the LP, the compounded included, is in the vault ...
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total.plus(minted));
        // ... and the strategy keeps at most dust of each pool token
        aeroLeft = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let usdcLeft = new BigNumber(await usdcToken.balanceOf(strategy.address));
        let alusdbLeft = new BigNumber(await alusdbToken.balanceOf(strategy.address));
        console.log("pool tokens and fees compounded ($, 18 decimals): ", held.toFixed(), " left over: USDC ", usdcLeft.toFixed(),
          " alUSDb ", alusdbLeft.toFixed(), " AERO ", aeroLeft.toFixed());
        Utils.assertBNGt(held, (await dollars(usdcLeft, alusdbLeft)).times(1000));
      } finally {
        await strategy.setMinStakeInterval(0, { from: governance });
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");

      // and less AERO than MIN_REWARD: AERO cannot be salvaged, so what withdrawAll leaves of it would stay in the strategy
      // for good after a migration. Checked last, so that a failure here leaves the strategy staked for the tests below
      assert.isTrue(aeroLeft.lt("10000000000000"), "withdrawAll should leave less AERO than MIN_REWARD (1e13 wei), not " + aeroLeft.toFixed());
    });

    it("Zaps through the pool when the keeper's priority fee is above Aero's MEV-tax threshold", async function() {
      // the zap quotes its swap with getAmountOutWithTotalFee, the pool's fee for this transaction with the MEV tax, so
      // the pool's own check (K) passes at any priority fee. 3 gwei is above the stable pools' 2 gwei threshold (and the
      // volatile pools' 1 gwei); this pool's base fee is 5 bps
      let taxedGasPrice = "3000000000";
      let baseFeeBps = 5;
      // the pool fee the strategy's own swap paid in `block`, and what it swapped (in the input token)
      async function zapFee(block) {
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "should zap");
        let fees = await poolEvents("Fees", block, strategy.address);
        assert.equal(fees.length, 1);
        let swapped = new BigNumber(zap[0].returnValues.amount0In).plus(zap[0].returnValues.amount1In);
        let charged = new BigNumber(fees[0].returnValues.amount0).plus(fees[0].returnValues.amount1);
        console.log("zap swapped ", swapped.toFixed(), " (token0 in: ", zap[0].returnValues.amount0In, ") and paid ", charged.toFixed(),
          " in fees (", charged.toNumber() / swapped.toNumber(), "), of which MEV tax over the base fee: ",
          charged.minus(swapped.times(baseFeeBps).idiv(10000)).toFixed());
        Utils.assertBNGt(charged.times(10000), swapped.times(baseFeeBps)); // more than the base fee: taxed
        return zap[0].returnValues;
      }

      // selling off, and only USDC to compound
      await strategy.setSell(false, { from: governance });
      try {
        let amount = (await burnLP(1000))[0];
        await usdcToken.transfer(strategy.address, amount.toFixed(), { from: farmer2 });
        // at that priority fee the pool pays out less than at the keeper's usual one: it charges the tax
        let half = amount.idiv(2).toFixed();
        let untaxed = new BigNumber(await pool.getAmountOutWithTotalFee(half, usdc, { from: strategy.address, gasPrice: keeperGasPrice }));
        let taxed = new BigNumber(await pool.getAmountOutWithTotalFee(half, usdc, { from: strategy.address, gasPrice: taxedGasPrice }));
        console.log("quotes for half of the USDC at the keeper's usual and at the taxed priority fee: ", untaxed.toFixed(), " ", taxed.toFixed());
        Utils.assertBNGt(untaxed, taxed);

        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: taxedGasPrice });
        let block = tx.receipt.blockNumber;
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        // the zap runs in the compounding, whose failures are reported as CompoundFailed
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "the zap should not fail the pool's check");
        await zapFee(block);
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint");
        // the zap's split does not count the tax (its price probe quotes the base fee): it left some USDC unpaired
        console.log("USDC left unpaired by the taxed zap: ", (await usdcToken.balanceOf(strategy.address)).toString(), " of ", amount.toFixed());
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // a hard work at the keeper's usual priority fee compounds that USDC, and sells the AERO kept while selling was off
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "should compound the USDC left unpaired");
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the USDC left unpaired");

      // with an AERO sale (selling on), at the same priority fee: the sale's swaps pay the tax too, the alUSDb leg twice (AERO
      // -> USDC, then USDC -> alUSDb through this pool), so the split comes out short of alUSDb, and the zap swaps USDC
      await Utils.advanceNBlock(600);
      let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: taxedGasPrice });
      block = tx.receipt.blockNumber;
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the sale should not fail the pool's check");
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0, "the zap should not fail the pool's check");
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO");
      let swap = await zapFee(block);
      Utils.assertBNGt(swap.amount0In, 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint");
      // what the zap could not pair stays in the strategy, in the token it swapped (token0). Its split values that token
      // at the base fee, so under the tax about a tenth of what it swapped stays unpaired; a zap that swapped half of what
      // it should would leave about twice what it swapped. Measured: 0.07 and 1.8, so the bound (a half) is ~7x and ~4x
      // from them; no bound can be more than ~5x from both. The zap test above (a token0 surplus without the tax) catches
      // such a zap by ~1e4x
      let token0Left = new BigNumber(await (await IERC20.at(await pool.token0())).balanceOf(strategy.address));
      console.log("token0 left unpaired by the taxed sale's zap: ", token0Left.toFixed(), " (", token0Left.toNumber() / Number(swap.amount0In),
        " of what it swapped)");
      Utils.assertBNGt(new BigNumber(swap.amount0In).idiv(2), token0Left);
    });

    it("Keeps the AERO sale and its fee when the compounding after it fails, still stakes, and compounds the pool tokens left with the next hard work", async function() {
      // the pool's mint fails (mintRevertsCode): only the compounding calls it, after the AERO sale, whose alUSDb leg swaps
      // through this same pool, and its fee. The compounding fails as a whole, its own swap included, and leaves the sale and
      // the fee done
      await mineBlocks(600); // AERO to claim and sell
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compounding");
      let lpBefore = await unstakedLP();
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let usdcBefore = new BigNumber(await usdcToken.balanceOf(strategy.address));
      let alusdbBefore = new BigNumber(await alusdbToken.balanceOf(strategy.address));
      let held;
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        // the sale and its fee, on all the AERO the strategy held, as always
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        let profits = await strategyEvents(profitLogInReward, block);
        assert.equal(profits.length, 1, "the AERO sale and its fee should stay done");
        let profit = new BigNumber(profits[0].args.profitAmount.toString());
        Utils.assertBNEq(profit, aeroBefore.plus(claimed));
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the compounding's failure should not undo the sale");
        // the AERO left the strategy for the fee and through the sale, a share for each pool token: neither is AERO, so all
        // of it is sold
        let forwarder = (await controller.rewardForwarder()).toLowerCase();
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        let fees = aeroOut.filter(transfer => transfer.args.to.toLowerCase() == forwarder);
        let sales = aeroOut.filter(transfer => transfer.args.to.toLowerCase() != forwarder);
        console.log("AERO out of the strategy: fee ", fees.map(transfer => transfer.args.value.toString()), " sold ",
          sales.map(transfer => transfer.args.value.toString() + " to " + transfer.args.to));
        assert.equal(fees.length, 1, "the fee");
        assert.equal(sales.length, 2, "the sales of the USDC and the alUSDb shares");
        Utils.assertBNEq(sales.reduce((total, sale) => total.plus(sale.args.value.toString()), new BigNumber(0)), profit.minus(fees[0].args.value.toString()));
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        // what the failed compounding records as fee-paid is the AERO it kept: none
        assert.equal((await feePaidReward()).toFixed(), (await aeroToken.balanceOf(strategy.address)).toString(), "the AERO kept should be recorded as fee-paid");
        // the compounding failed with the pool's own error, and as a whole: no swap of its own, no mint, no pool token sent
        let failures = await strategyEvents("CompoundFailed", block);
        assert.equal(failures.length, 1, "the compounding should fail without reverting");
        assert.equal(failures[0].args.reason, "0xdeadbeef", "the pool's own revert data");
        assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the zap's swap should be undone with the mint");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 0);
        Utils.assertBNEq(await mintedLP(block), 0);
        for (let token of [usdcToken, alusdbToken]) {
          let out = await token.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
          assert.equal(out.length, 0, "no pool token should leave the strategy");
        }
        // so the pool tokens wait in the strategy: the USDC and the alUSDb the sale bought
        Utils.assertBNGt(await usdcToken.balanceOf(strategy.address), usdcBefore);
        Utils.assertBNGt(await alusdbToken.balanceOf(strategy.address), alusdbBefore);
        held = await poolTokensHeld();
        // and the idle LP is staked all the same
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should still stake");
        Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore);
        Utils.assertBNEq(await unstakedLP(), 0);
      });

      // with the pool's mint back, the next hard work compounds them with what it claims: it mints LP to the strategy and
      // stakes it, leaving almost nothing
      let block = await doHardWork();
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the pool tokens left");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      let leftover = await poolTokensHeld();
      console.log("pool tokens left by the failed compounding ($, 18 decimals): ", held.toFixed(), " compounded with the next claim into LP worth: ",
        (await lpDollars(minted)).toFixed(), " left over: ", leftover.toFixed());
      Utils.assertBNGt(held, leftover.times(100)); // leftover below 1%
      // neither pool token is AERO: the next hard work takes the fee on what it claims, and nothing else, and nothing is
      // recorded as fee-paid
      let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
      let profits = await strategyEvents(profitLogInReward, block);
      assert.equal(profits.length, 1);
      Utils.assertBNEq(profits[0].args.profitAmount.toString(), claimed);
      assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");
      // and its sale sells all that the fee left of it (the volatile suite checks that its sale splits only that, the AERO
      // kept for its pool going in unsold)
      let sale = await rewardSale(block);
      console.log("the next run's AERO sold ", sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left");
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the new AERO");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
    });

    it("Reports a compounding failure without revert data as CompoundFailed too, keeps the AERO sale and its fee, and compounds the pool tokens with the next hard work", async function() {
      // only Aero's own gas check error is re-raised from the compounding: a failure without revert data (an empty revert,
      // as from a call that ran out of gas) is reported like the 0xdeadbeef of the test above, with the sale and its fee
      // left done. Here the pool's mint reverts with no data (mintRevertsCode with emptyRevertCode)
      await mineBlocks(600); // AERO to claim and sell
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compounding");
      let lpBefore = await unstakedLP();
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let usdcBefore = new BigNumber(await usdcToken.balanceOf(strategy.address));
      let alusdbBefore = new BigNumber(await alusdbToken.balanceOf(strategy.address));
      let held;
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        // the sale and its fee, on all the AERO the strategy held: neither pool token is AERO, so all of it is sold
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        let profits = await strategyEvents(profitLogInReward, block);
        assert.equal(profits.length, 1, "the AERO sale and its fee should stay done");
        Utils.assertBNEq(profits[0].args.profitAmount.toString(), aeroBefore.plus(claimed));
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "a compounding failure without revert data should not undo the sale");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        // the compounding failed as a whole, with the pool's empty revert data
        let failures = await strategyEvents("CompoundFailed", block);
        assert.equal(failures.length, 1, "the compounding should fail without reverting");
        assert.include([null, "0x"], failures[0].args.reason, "the pool's own (empty) revert data");
        assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the zap's swap should be undone with the mint");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 0);
        Utils.assertBNEq(await mintedLP(block), 0);
        // so the pool tokens wait in the strategy, and the idle LP is staked all the same
        Utils.assertBNGt(await usdcToken.balanceOf(strategy.address), usdcBefore);
        Utils.assertBNGt(await alusdbToken.balanceOf(strategy.address), alusdbBefore);
        held = await poolTokensHeld();
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should still stake");
        Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore);
        Utils.assertBNEq(await unstakedLP(), 0);
        // what the failed compounding records as fee-paid is the AERO it kept: none
        assert.equal((await feePaidReward()).toFixed(), (await aeroToken.balanceOf(strategy.address)).toString(), "the AERO kept should be recorded as fee-paid");
        console.log("compounding failure without revert data (", failures[0].args.reason, "): AERO sold with its fee ",
          profits[0].args.profitAmount.toString(), ", pool tokens left ($, 18 decimals): ", held.toFixed());
      }, emptyRevertCode);

      // with the pool's mint back, the next hard work compounds them into LP and stakes it, leaving almost nothing
      let block = await doHardWork();
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the pool tokens left");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      let leftover = await poolTokensHeld();
      console.log("pool tokens left by the compounding failure without revert data ($, 18 decimals): ", held.toFixed(),
        " compounded with the next claim into LP worth: ", (await lpDollars(minted)).toFixed(), " left over: ", leftover.toFixed());
      Utils.assertBNGt(held, leftover.times(100)); // leftover below 1%
      // the fee is taken on what the run brought only, as after the 0xdeadbeef failure above, and nothing is recorded
      Utils.assertBNEq(await feeBase(block), await newAero(block));
      assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");
      // and its sale sells all that the fee left of it, as in the test above
      let sale = await rewardSale(block);
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the new AERO");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
    });

    it("Reports a failed compounding with selling off, goes on with the hard work, and compounds the pool tokens with the next one", async function() {
      await strategy.setSell(false, { from: governance });
      try {
        // only pool tokens to compound (the AERO, reserved, is none of them): the USDC behind 0.05% of farmer2's LP
        let usdcIn = (await burnLP(2000))[0];
        await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
        await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP
        let lpBefore = await unstakedLP();
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let usdcHeld = new BigNumber(await usdcToken.balanceOf(strategy.address));
        let alusdbHeld = new BigNumber(await alusdbToken.balanceOf(strategy.address));
        await withPoolMintFailing(async () => {
          let block = await doHardWork();
          let notCollected = await strategyEvents(profitsNotCollected, block);
          assert.equal(notCollected.length, 1, "should report the profits as not collected");
          assert.equal(notCollected[0].args.sell, false);
          assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee");
          let failures = await strategyEvents("CompoundFailed", block);
          assert.equal(failures.length, 1, "the compounding should fail without reverting");
          assert.equal(failures[0].args.reason, "0xdeadbeef", "the pool's own revert data");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          // the hard work goes on: it claims, and stakes the idle LP
          let claimed = await gaugeEvents("EmissionsClaimed", block);
          assert.equal(claimed.length, 1, "should claim");
          let deposits = await gaugeEvents("Deposit", block);
          assert.equal(deposits.length, 1, "should still stake");
          Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore);
          // and the pool tokens wait: none left the strategy (the zap's swap was undone with the mint), and it keeps the
          // AERO it claimed
          assert.equal((await poolEvents("Swap", block, strategy.address)).length, 0, "the zap's swap should be undone with the mint");
          Utils.assertBNEq(await mintedLP(block), 0);
          for (let token of [usdcToken, alusdbToken, aeroToken]) {
            let out = await token.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
            assert.equal(out.length, 0, "no pool token or AERO should leave the strategy");
          }
          let feeClaimed = (await feeClaims(block)).reduce((total, claim) => [total[0].plus(claim.returnValues.amount0), total[1].plus(claim.returnValues.amount1)],
            [new BigNumber(0), new BigNumber(0)]);
          Utils.assertBNEq(await usdcToken.balanceOf(strategy.address), usdcHeld.plus(feeClaimed[0]));
          Utils.assertBNEq(await alusdbToken.balanceOf(strategy.address), alusdbHeld.plus(feeClaimed[1]));
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(claimed[0].args._rewardAmount.toString()));
          // that AERO was reserved, its fee not taken: none of it is recorded as fee-paid
          assert.equal((await feePaidReward()).toFixed(), "0", "AERO whose fee was not taken should not be recorded as fee-paid");
        });

        // with the pool's mint back, the next hard work (selling still off) zaps the USDC into LP
        let usdcWaiting = new BigNumber(await usdcToken.balanceOf(strategy.address));
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
        let zap = await poolEvents("Swap", block, strategy.address);
        assert.equal(zap.length, 1, "should zap the USDC");
        Utils.assertBNGt(zap[0].returnValues.amount0In, 0);
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1);
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake the LP minted");
        Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
        Utils.assertBNGt(await dollars(usdcWaiting, 0), (await poolTokensHeld()).times(1000));
        assert.equal((await feePaidReward()).toFixed(), "0", "AERO whose fee was not taken should not be recorded as fee-paid");
      } finally {
        await strategy.setSell(true, { from: governance });
      }
    });

    it("Takes the fee once through two failed compoundings in a row: each run on what it brings only, until a compounding goes through and clears the record, and the next run on all it holds", async function() {
      // neither pool token is AERO: each sale sells all the AERO, so a failed compounding keeps none and records nothing as
      // fee-paid, and each run's fee base is the AERO it holds and brings (the same steps as in the volatile suite, where
      // the AERO kept for the pool is recorded)
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compoundings");
      let held;
      await withPoolMintFailing(async () => {
        // the first: the fee on what it brings and on all the AERO the strategy held (the selling-off test above reserved it)
        await mineBlocks(600); // AERO to claim and sell
        await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP: idle during the sale, it earns pool fees on it
        let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail without reverting");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the compounding's failure should not undo the sale");
        Utils.assertBNEq(await feeBase(block), aeroHeld.plus(await newAero(block)));
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");

        // the second: the fee on its own claim only
        await mineBlocks(600);
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail again without reverting");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the compounding's failure should not undo the sale");
        let brought = await newAero(block);
        Utils.assertBNEq(await feeBase(block), brought);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");
        held = await poolTokensHeld();
        let sale = await rewardSale(block);
        console.log("two failed compoundings: the second's fee base: AERO claimed ", brought.toFixed(), "; its AERO sold ", sale.sold.toFixed(), " of the ",
          sale.split.toFixed(), " the fee left; pool tokens held ($, 18 decimals): ", held.toFixed());
        // the second sale sells all that the fee left of what it brought (the volatile suite checks that it splits only that)
        assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the second sale should sell all that the fee left of what it brought");
      });

      // with the pool's mint back, the compounding goes through: the fee on its own claim only, the pool tokens into LP,
      // which is staked
      await mineBlocks(600);
      let block = await doHardWork();
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), await newAero(block));
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should mint LP from the pool tokens left");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");
      let leftover = await poolTokensHeld();
      console.log("pool tokens left by two failed compoundings ($, 18 decimals): ", held.toFixed(), " compounded with the next claim into LP worth: ",
        (await lpDollars(minted)).toFixed(), " left over: ", leftover.toFixed());
      Utils.assertBNGt(held, leftover.times(100)); // leftover below 1%
      // its sale sells all that the fee left of what it brought
      let sale = await rewardSale(block);
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of what it brought");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);

      // the next run takes the fee on all the AERO it holds, and on what it brings
      await mineBlocks(600);
      let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
      block = await doHardWork();
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), aeroHeld.plus(await newAero(block)));
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Compounds what a failed compounding left, without a fee, when selling is switched off before the next hard work, also after a compounding that fails again there, and takes the fee on the rewards those runs reserved once selling is back on", async function() {
      // with selling off a hard work takes no fee and reserves the AERO whose fee it has not taken: its claim. The pool
      // tokens the failed compounding left (its sale sold all the AERO, neither pool token being AERO) go into the pool. A
      // compounding that fails again with selling off must keep the record it finds, as in the volatile suite, where the
      // failed compounding recorded the AERO it kept for the pool; here the test writes a record below the AERO held into
      // the strategy's storage, as the stale-value tests below do
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compounding");
      await mineBlocks(600); // AERO to claim and sell
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP: idle during the sale, it earns pool fees on it
      let held;
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail without reverting");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO sale and its fee should stay done");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");
        held = await poolTokensHeld();
      });
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);

      await strategy.setSell(false, { from: governance });
      try {
        let reserved, block;
        await writeFeePaidReward(recorded);
        try {
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
          // the first hard work with selling off fails to compound too (the pool's mint still failing): it keeps the record
          // it found, and records none of the new rewards it reserves, whose fee it has not taken
          await withPoolMintFailing(async () => {
            let failed = await doHardWork();
            let notCollected = await strategyEvents(profitsNotCollected, failed);
            assert.equal(notCollected.length, 1, "should report the profits as not collected");
            assert.equal(notCollected[0].args.sell, false);
            assert.equal((await strategyEvents(profitLogInReward, failed)).length, 0, "should take no fee");
            let failures = await strategyEvents("CompoundFailed", failed);
            assert.equal(failures.length, 1, "the compounding should fail again without reverting");
            assert.equal(failures[0].args.reason, "0xdeadbeef", "the pool's own revert data");
            assert.equal((await strategyEvents("LiquidationFailed", failed)).length, 0);
            reserved = await newAero(failed);
            Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), sent.plus(reserved));
            assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(),
              "a compounding that fails with selling off should keep the record it found, and not record the rewards it reserved");
          });
          // the pool tokens the next one compounds: all those held (that run's pool fee claim added to them)
          held = await poolTokensHeld();
          block = await doHardWork();
          assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");
        } finally {
          await writeFeePaidReward(0);
        }
        let notCollected = await strategyEvents(profitsNotCollected, block);
        assert.equal(notCollected.length, 1, "should report the profits as not collected");
        assert.equal(notCollected[0].args.sell, false);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee");
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        // what the failed compoundings left goes into the pool, and the LP minted is staked ...
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
        let minted = await mintedLP(block);
        Utils.assertBNGt(minted, 0);
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake the LP minted");
        Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
        // ... while the new rewards of both runs, reserved, stay out of it with the AERO sent (no pool token here): the
        // strategy keeps them, and at most dust of the pool tokens
        reserved = reserved.plus(await newAero(block));
        Utils.assertBNGt(reserved, 0);
        let aeroLeft = new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(sent).minus(reserved);
        let leftover = await poolTokensHeld();
        console.log("selling off after a failed compounding: pool tokens held ($, 18 decimals): ", held.toFixed(), " compounded into LP worth ",
          (await lpDollars(minted)).toFixed(), ", left over: ", leftover.toFixed(), " (", leftover.toNumber() / held.toNumber(), "); AERO reserved ", reserved.toFixed(),
          ", AERO left besides it and the AERO sent ", aeroLeft.toFixed());
        Utils.assertBNEq(aeroLeft, 0);
        // the pool tokens left below 1% of those held: measured 5.2e-6 of them; not compounding while selling is off (C5a)
        // leaves all of them
        Utils.assertBNGt(held, leftover.times(100));
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // with selling back on, the next hard work takes the fee on all the AERO it holds (the rewards reserved while selling
      // was off, and the AERO sent: the compounding that went through cleared the record, so the part of it the record
      // covered is charged again, which only a record written by the test shows on this pool) and on what it brings, and
      // sells all of it
      let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), aeroHeld.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Compounds what a failed compounding left, without a fee, with a next hard work that brings only reward dust (its claim fails)", async function() {
      // the next hard work's claim fails (Aero's minting paused): it brings no AERO, and holds only the AERO dust farmer2
      // sends (the failed run sold all its AERO), below MIN_REWARD, so it takes no fee and sells nothing (the reward-dust
      // path): the dust waits for the next claim. The pool tokens left still go into the pool. No new LP before the failed
      // run, as in the volatile suite: nothing is idle in the strategy during its sale, so it is owed no pool fees
      // afterwards either
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compounding");
      await mineBlocks(600); // AERO to claim and sell
      let dust = new BigNumber("1000000000000"); // a tenth of MIN_REWARD (1e13)
      let held;
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail without reverting");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO sale and its fee should stay done");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");
        held = await poolTokensHeld();
      });
      let pending = await pendingFees();
      Utils.assertBNEq(new BigNumber(pending.amount0).plus(pending.amount1), 0);
      // AERO dust whose fee was not taken: farmer2's (farmer2Aero)
      await farmer2Aero(dust);
      await aeroToken.transfer(strategy.address, dust.toFixed(), { from: farmer2 });

      let block;
      await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
      try {
        block = await doHardWork();
      } finally {
        await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
      }
      let failures = await strategyEvents("ClaimFailed", block);
      assert.equal(failures.length, 1, "the claim should fail without reverting");
      assert.notEqual(failures[0].args.reason, insufficientGasError, "minting paused, not Aero's gas check");
      Utils.assertBNEq(await newAero(block), 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee on dust: the run brought no AERO");
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      // the pool tokens go into the pool, and the LP minted is staked (no window: no need for the claim)
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      let leftover = await poolTokensHeld();
      console.log("reward dust after a failed compounding: pool tokens held ($, 18 decimals): ", held.toFixed(), " compounded into LP worth ",
        (await lpDollars(minted)).toFixed(), ", left over: ", leftover.toFixed(), " (", leftover.toNumber() / held.toNumber(), "); AERO dust kept ",
        (await aeroToken.balanceOf(strategy.address)).toString());
      // the pool tokens left below 1% of those held: measured 1.6e-6 to 3e-6 of them; compounding only after a reward sale
      // (C5d) leaves all of them
      Utils.assertBNGt(held, leftover.times(100));
      // the dust, whose fee was not taken, stays in the strategy: AERO is no pool token here, nothing moves it
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
      assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");

      // the next claim takes the fee on the dust and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), dust.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Records as fee-paid the AERO a failed compounding kept, never the reward dust beside it, when the compounding fails again in a hard work that brings only dust", async function() {
      // the reward-dust path reserves the AERO whose fee was not taken (the dust): when its compounding fails, the record
      // must leave that dust out, so that the next claim takes the fee on it. After a failed compounding (which keeps no
      // AERO here, neither pool token being AERO), farmer2 sends the strategy AERO dust, and the next hard work, whose claim
      // fails (minting paused), fails to compound the pool tokens left again (the pool's mint still failing)
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compoundings");
      await mineBlocks(600); // AERO to claim and sell
      let dust = new BigNumber("1000000000000"); // a tenth of MIN_REWARD (1e13)
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail without reverting");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO sale and its fee should stay done");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");

        // AERO dust whose fee was not taken: farmer2's (farmer2Aero)
        await farmer2Aero(dust);
        await aeroToken.transfer(strategy.address, dust.toFixed(), { from: farmer2 });
        await leafVoter.setChainStatus(2, { from: penaltyAdmin }); // Paused: minting reverts
        try {
          block = await doHardWork();
        } finally {
          await leafVoter.setChainStatus(1, { from: penaltyAdmin }); // Active again
        }
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 1, "the claim should fail without reverting");
        Utils.assertBNEq(await newAero(block), 0);
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee on dust");
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail again without reverting");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
        assert.equal((await feePaidReward()).toFixed(), "0", "the reward dust, whose fee was not taken, should not be recorded as fee-paid");
      });

      // with the pool's mint back, the next claim takes the fee on the dust and on what it brings, and sells all of it
      let block = await doHardWork();
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), dust.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should leave feePaidReward at 0");
      let sale = await rewardSale(block);
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the dust and the new AERO");
    });

    it("Clamps a stale feePaidReward above the AERO it holds, with selling on or off: the liquidation goes through without a fee on that AERO, compounds, and clears the value", async function() {
      // the strategy only records AERO it holds, but a stale value above that (say, from another implementation) must not
      // underflow the liquidation: feePaidReward is clamped to the AERO held at its start. The test writes one into the
      // strategy's storage, the proxy's: strategy.address is the proxy (the implementation has no implementation() to
      // answer). Reading the stale value back below is the control that the write reached the strategy's storage. The
      // slot check guards the test's own formula, which must give the contract's _FEE_PAID_REWARD_SLOT literal (the
      // volatile suite checks that the contract writes there, after a real failed compounding)
      assert.equal(feePaidRewardSlot, "0xdee4b1c857a7cb713eed053196a5167e138327b62a7962ed114649742e13d192", "the slot of feePaidReward");
      await (await StrategyProxy.at(strategy.address)).implementation();
      assert.equal((await feePaidReward()).toFixed(), "0");
      let stale = new BigNumber(2).pow(255);
      // a pool token to compound, as in the volatile suite: the USDC behind 0.05% of farmer2's LP
      let usdcIn = (await burnLP(2000))[0];
      await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
      await mineBlocks(600); // AERO to claim
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let held = await poolTokensHeld();
      let block;
      await writeFeePaidReward(stale);
      try {
        assert.equal((await feePaidReward()).toFixed(), stale.toFixed(), "the test should write feePaidReward into the strategy's storage");
        block = await doHardWork();
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear even a stale feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      // the clamp keeps the fee base from underflowing: the liquidation goes through ...
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the clamp should keep the liquidation from underflowing");
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      // ... and counts all the AERO held at its start as fee-paid, the new claim included: this run takes no fee. On this
      // pool that AERO is no pool token, so it is not sold either (no sale without the fee): it waits for the next run,
      // which takes the fee on it. A stale value only delays the sale here, once: the compounding clears it
      let claims = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claims.length, 1, "should claim");
      let total = aeroBefore.plus(await newAero(block));
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee on the AERO the clamped value covers");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), total);
      // the USDC goes into the pool, and the LP minted is staked
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the USDC");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      let leftover = await poolTokensHeld();
      console.log("stale feePaidReward: AERO held at the liquidation ", total.toFixed(), " (claimed ", claims[0].args._rewardAmount.toString(),
        ") kept without a fee; pool tokens held ($, 18 decimals): ", held.toFixed(), " compounded into LP worth ", (await lpDollars(minted)).toFixed(), ", left over: ", leftover.toFixed(),
        " (", leftover.toNumber() / held.toNumber(), ")");
      // the pool tokens left below 1% of those held: measured 5.5e-7 to 9e-7 of them; compounding only after a reward sale
      // (C5d: the clamped value leaves nothing to sell) leaves all of them
      Utils.assertBNGt(held, leftover.times(100));

      // with selling off, the same stale value must not underflow the liquidation either: clamped to the AERO held, it
      // counts all of it as fee-paid, so none of it is reserved (no fee is taken with selling off anyway; on this pool that
      // AERO stays all the same, being no pool token), and the pool tokens go into the pool: the USDC behind another 0.05%
      // of farmer2's LP
      usdcIn = (await burnLP(2000))[0];
      await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
      await mineBlocks(600); // AERO to claim
      aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      await strategy.setSell(false, { from: governance });
      try {
        await writeFeePaidReward(stale);
        try {
          assert.equal((await feePaidReward()).toFixed(), stale.toFixed(), "the test should write feePaidReward into the strategy's storage");
          block = await doHardWork();
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0, "the clamp should keep the liquidation from underflowing with selling off too");
          assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear even a stale feePaidReward");
        } finally {
          await writeFeePaidReward(0);
        }
      } finally {
        await strategy.setSell(true, { from: governance });
      }
      let notCollected = await strategyEvents(profitsNotCollected, block);
      assert.equal(notCollected.length, 1, "should report the profits as not collected");
      assert.equal(notCollected[0].args.sell, false);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee with selling off");
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      claims = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claims.length, 1, "should claim");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(await newAero(block)));
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the USDC");
      minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);
      console.log("stale feePaidReward with selling off: AERO kept ", (await aeroToken.balanceOf(strategy.address)).toString(), " (claimed ", claims[0].args._rewardAmount.toString(),
        "); pool tokens compounded into LP worth ", (await lpDollars(minted)).toFixed(), " ($, 18 decimals), left over: ", (await poolTokensHeld()).toFixed());

      // the next run takes the fee on all the AERO it holds again, and on what it brings, and sells all of it
      let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), aeroHeld.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Counts a stale feePaidReward below the AERO it holds as fee-paid: the fee and the sale's split leave that AERO out, and the value is cleared", async function() {
      // a stale value below the AERO held counts as AERO whose fee was taken: the run takes the fee on the rest of the AERO it
      // holds and on what it brings, and sells what the fee left of that only. On this pool the fee-paid AERO is no pool
      // token, so the compounding leaves it too: it waits in the strategy for the next run, which takes the fee on it (the
      // compounding cleared the record). The test writes the value into the strategy's storage, as in the test above
      assert.equal((await feePaidReward()).toFixed(), "0");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0); // the run above sold all of it
      // AERO for the strategy to hold before the run: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      await mineBlocks(600); // AERO to claim
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let stale = aeroBefore.idiv(2);
      Utils.assertBNGt(stale, 0);
      let block;
      await writeFeePaidReward(stale);
      try {
        assert.equal((await feePaidReward()).toFixed(), stale.toFixed(), "the test should write feePaidReward into the strategy's storage");
        block = await doHardWork();
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear the stale feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      let claims = await gaugeEvents("EmissionsClaimed", block);
      assert.equal(claims.length, 1, "should claim");
      // the fee on all the AERO held at the liquidation but the stale value ...
      let total = aeroBefore.plus(await newAero(block));
      Utils.assertBNEq(await feeBase(block), total.minus(stale));
      // ... and the sale sells all that the fee left of that, and nothing else: the stale value's AERO stays
      let sale = await rewardSale(block);
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      console.log("stale feePaidReward below the AERO held: AERO held at the liquidation ", total.toFixed(), " (claimed ", claims[0].args._rewardAmount.toString(),
        "), stale value ", stale.toFixed(), "; AERO sold ", sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ", aeroKept.toFixed());
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not counted as fee-paid");
      assert.equal(aeroKept.toFixed(), stale.toFixed(), "the AERO the stale value covers should stay unsold");
      // the pool tokens the sale bought go into the pool, and the LP minted is staked
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens the sale bought");
      let minted = await mintedLP(block);
      Utils.assertBNGt(minted, 0);
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake the LP minted");
      Utils.assertBNEq(deposits[0].args._amount.toString(), minted);

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), stale.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through a liquidation that fails as a whole, and takes the fee once with the next one that goes through", async function() {
      // a liquidation that fails as a whole (here its AERO sale, whose alUSDb leg goes through this pool, while Aero has
      // paused swaps) undoes its own fee (it fails before its compounding, so it writes no record), and must not touch the
      // record it found: the next run that goes through still finds that AERO fee-paid. On this pool a failed compounding
      // records nothing (its sale sold all the AERO), so the test writes a record below the AERO held into the strategy's
      // storage, as the stale-value tests do
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the failed compounding");
      await mineBlocks(600); // AERO to claim and sell
      await withPoolMintFailing(async () => {
        let block = await doHardWork();
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 1, "the compounding should fail without reverting");
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "the AERO sale and its fee should stay done");
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
        assert.equal((await feePaidReward()).toFixed(), "0", "a failed compounding that kept no AERO should record none as fee-paid");
      });
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      let aeroHeld, block;
      await writeFeePaidReward(recorded);
      try {
        assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
        // the next hard work claims, so that it tries to sell what it brought, and that sale fails
        await mineBlocks(600);
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        await withSwapsPaused(async () => {
          let paused = await doHardWork();
          assert.equal((await gaugeEvents("EmissionsClaimed", paused)).length, 1, "the claim should go through, so that the sale is tried");
          let failures = await strategyEvents("LiquidationFailed", paused);
          assert.equal(failures.length, 1, "the AERO sale should fail the whole liquidation, without reverting");
          assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("IsPaused()"), "the pool's own error");
          assert.equal((await strategyEvents(profitLogInReward, paused)).length, 0, "the fee should be undone with the liquidation");
          assert.equal((await strategyEvents("CompoundFailed", paused)).length, 0, "the liquidation should fail before its compounding");
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(await newAero(paused)));
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "a liquidation that fails as a whole should keep the record");
        });

        // the next hard work takes the fee once: on all the AERO it holds but the recorded AERO, and on what it brings. It
        // sells what the fee left of that only, the recorded AERO stays (no pool token here), and the record is cleared
        aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
        block = await doHardWork();
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), aeroHeld.minus(recorded).plus(await newAero(block)));
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      let sale = await rewardSale(block);
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      console.log("after a liquidation that failed as a whole: AERO recorded as fee-paid ", recorded.toFixed(), " of the ", aeroHeld.toFixed(), " held; AERO sold ",
        sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ", aeroKept.toFixed());
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not recorded as fee-paid");
      assert.equal(aeroKept.toFixed(), recorded.toFixed(), "the recorded AERO should stay unsold");

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), recorded.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through a withdrawAll, its exit and a liquidation there that fails as a whole, and takes the fee once with the next withdrawAll", async function() {
      // withdrawAll (a rebalance, a migration, the last share's withdrawal) takes the whole stake out first, then claims and
      // liquidates on its own: neither that exit nor a liquidation that fails as a whole there may forget the record it
      // finds. On this pool a failed compounding records nothing (its sale sells all the AERO), so the test writes a record
      // below the AERO held into the strategy's storage, as the stale-value tests do
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let restaked;
      try {
        await writeFeePaidReward(recorded);
        try {
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
          // a withdrawAll whose claim brings AERO to sell, and whose sale fails (swaps paused, for its alUSDb leg): it takes
          // the whole stake out and hands all the LP to the vault, its liquidation fails as a whole, and the record stays
          await withSwapsPaused(async () => {
            let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
            let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
            let paused = tx.receipt.blockNumber;
            let withdrawn = await gaugeEvents("Withdraw", paused);
            assert.equal(withdrawn.length, 1, "should take the whole stake out");
            Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            assert.equal((await gaugeEvents("EmissionsClaimed", paused)).length, 1, "the claim should go through, so that the sale is tried");
            let failures = await strategyEvents("LiquidationFailed", paused);
            assert.equal(failures.length, 1, "the AERO sale should fail the whole liquidation, without reverting withdrawAll");
            assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("IsPaused()"), "the pool's own error");
            assert.equal((await strategyEvents(profitLogInReward, paused)).length, 0, "the fee should be undone with the liquidation");
            assert.equal((await strategyEvents("CompoundFailed", paused)).length, 0, "the liquidation should fail before its compounding");
            Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroBefore.plus(await newAero(paused)));
            Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
            Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
            assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "neither withdrawAll's exit nor its failed liquidation should touch the record");
          });

          // the next withdrawAll takes the fee once: on all the AERO it holds but the recorded AERO, and on what it brings.
          // It sells what the fee left of that only, the recorded AERO stays (no pool token here), the LP minted goes to the
          // vault, and the record is cleared
          let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
          let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
          let block = tx.receipt.blockNumber;
          assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
          Utils.assertBNEq(await feeBase(block), aeroHeld.minus(recorded).plus(await newAero(block)));
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens the sale bought");
          Utils.assertBNGt(await mintedLP(block), 0);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          let sale = await rewardSale(block);
          let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
          console.log("withdrawAll after a written record: AERO recorded as fee-paid ", recorded.toFixed(), " of the ", aeroHeld.toFixed(), " held; AERO sold ",
            sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ", aeroKept.toFixed());
          assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not recorded as fee-paid");
          assert.equal(aeroKept.toFixed(), recorded.toFixed(), "the recorded AERO should stay unsold");
        } finally {
          await writeFeePaidReward(0);
        }
      } finally {
        // the next hard work stakes all the LP again, also when a check above fails, so that the tests below find it staked
        restaked = await doHardWork();
      }
      // and it takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      assert.equal((await gaugeEvents("Deposit", restaked)).length, 1, "should stake everything again");
      Utils.assertBNEq(await unstakedLP(), 0);
      Utils.assertBNEq(await feeBase(restaked), recorded.plus(await newAero(restaked)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through a compounding that fails in withdrawAll, still hands all the LP to the vault, and compounds the pool tokens without a fee on the recorded AERO with the next withdrawAll", async function() {
      // withdrawAll (a rebalance, a migration, the last share's withdrawal) takes the whole stake out, then claims and
      // liquidates on its own: a compounding that fails there is reported as in a hard work (CompoundFailed, not
      // LiquidationFailed: its sale and fee stay done), keeps the record, and all the LP still goes to the vault. On this
      // pool the sale sells all the AERO, so the test writes a record below the AERO held into the strategy's storage, as
      // the stale-value tests do: the sale leaves that AERO unsold, and the failed compounding records it again
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let restaked;
      try {
        await writeFeePaidReward(recorded);
        try {
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
          await withPoolMintFailing(async () => {
            let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
            let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
            let failed = tx.receipt.blockNumber;
            let withdrawn = await gaugeEvents("Withdraw", failed);
            assert.equal(withdrawn.length, 1, "should take the whole stake out");
            Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
            Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
            let failures = await strategyEvents("CompoundFailed", failed);
            assert.equal(failures.length, 1, "the compounding should fail without reverting withdrawAll");
            assert.equal(failures[0].args.reason, "0xdeadbeef", "the pool's own revert data");
            assert.equal((await strategyEvents("LiquidationFailed", failed)).length, 0, "the compounding's failure should not undo the sale");
            assert.equal((await poolEvents("Swap", failed, strategy.address)).length, 0, "the zap's swap should be undone with the mint");
            Utils.assertBNEq(await mintedLP(failed), 0);
            // the fee on all the AERO held but the recorded AERO, and on what withdrawAll brought: its sale sold all the
            // rest, and the failed compounding records the recorded AERO again
            let brought = await newAero(failed);
            let profit = await feeBase(failed);
            let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
            let after = await feePaidReward();
            console.log("compounding failed in withdrawAll: AERO held ", aeroBefore.toFixed(), " (recorded as fee-paid ", recorded.toFixed(), ") + brought ",
              brought.toFixed(), ", fee base ", profit.toFixed(), "; AERO kept ", aeroKept.toFixed(), ", recorded after ", after.toFixed());
            Utils.assertBNEq(profit, aeroBefore.plus(brought).minus(recorded));
            Utils.assertBNEq(aeroKept, recorded);
            assert.equal(after.toFixed(), recorded.toFixed(), "the failed compounding should keep the record");
            // and all the LP is in the vault, none left in the strategy, which keeps the pool tokens its sale bought
            Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
            Utils.assertBNEq(await vault.underlyingBalanceInVault(), total);
            Utils.assertBNGt(await poolTokensHeld(), 0);
          });

          // the next withdrawAll, with the pool's mint back and nothing staked, brings no AERO (this pool's fees are paid in
          // its own tokens) and holds only the recorded AERO: it takes no fee and sells nothing, compounds the pool tokens
          // into LP, which goes to the vault, and clears the record. The recorded AERO stays (no pool token here)
          let vaultLP = new BigNumber(await vault.underlyingBalanceInVault());
          let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
          let block = tx.receipt.blockNumber;
          let minted = await mintedLP(block);
          console.log("the next withdrawAll: AERO brought ", (await newAero(block)).toFixed(), ", fees taken ", (await strategyEvents(profitLogInReward, block)).length,
            "; AERO kept ", (await aeroToken.balanceOf(strategy.address)).toString(), "; LP minted worth ", (await lpDollars(minted)).toFixed(), " ($, 18 decimals)");
          assert.equal((await gaugeEvents("Withdraw", block)).length, 0, "nothing should be left to unstake");
          assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
          assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
          Utils.assertBNEq(await newAero(block), 0);
          assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee on the recorded AERO");
          assert.equal((await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block })).length, 0,
            "no AERO should leave the strategy");
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded);
          assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
          Utils.assertBNGt(minted, 0);
          Utils.assertBNEq(await vault.underlyingBalanceInVault(), vaultLP.plus(minted));
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
        } finally {
          await writeFeePaidReward(0);
        }
      } finally {
        // the next hard work stakes all the LP again, also when a check above fails, so that the tests below find it staked
        restaked = await doHardWork();
      }
      // and it takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      assert.equal((await gaugeEvents("Deposit", restaked)).length, 1, "should stake everything again");
      Utils.assertBNEq(await unstakedLP(), 0);
      Utils.assertBNEq(await feeBase(restaked), recorded.plus(await newAero(restaked)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through the exit that follows a failed compounding in the same hard work (kept unstaked), and compounds without a fee on that AERO", async function() {
      // kept unstaked by governance (as for a gauge Aero switched off), the hard work takes the whole stake out right after
      // its claim and its liquidation: that exit must not forget the record the compounding just before it wrote. On this
      // pool the sale sells all the AERO, so the test writes a record below the AERO held into the strategy's storage: the
      // sale leaves that AERO unsold, and the failed compounding records it again
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      let staked = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(staked, 0);
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let held, leftover, block;
      await writeFeePaidReward(recorded);
      try {
        try {
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
          await strategy.setKeepUnstaked(true, { from: governance });
          try {
            await withPoolMintFailing(async () => {
              let failed = await doHardWork();
              assert.equal((await gaugeEvents("EmissionsClaimed", failed)).length, 1, "should claim");
              Utils.assertBNEq(await feeBase(failed), aeroBefore.plus(await newAero(failed)).minus(recorded));
              assert.equal((await strategyEvents("CompoundFailed", failed)).length, 1, "the compounding should fail without reverting");
              let unstaked = await strategyEvents("UnstakedFromGauge", failed);
              assert.equal(unstaked.length, 1, "should take the whole stake out after the liquidation");
              Utils.assertBNEq(unstaked[0].args.amount.toString(), staked);
              Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
              Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded); // its sale sold all the rest
              assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the exit should keep the record the failed compounding wrote");
              held = await poolTokensHeld();
            });
          } finally {
            await strategy.setKeepUnstaked(false, { from: governance });
          }
        } finally {
          // with keepUnstaked off and the pool's mint back, the next hard work stakes all the LP again, also when a check
          // above fails, so that the tests below find it staked
          block = await doHardWork();
        }
        leftover = await poolTokensHeld();
        console.log("exit after a failed compounding: AERO recorded as fee-paid ", recorded.toFixed(), ", kept ", (await aeroToken.balanceOf(strategy.address)).toString(),
          "; pool tokens held ($, 18 decimals) ", held.toFixed(), " compounded without a fee into LP worth ", (await lpDollars(await mintedLP(block))).toFixed(),
          ", left over ", leftover.toFixed(), " (", leftover.toNumber() / held.toNumber(), " of them)");
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      // it brings no AERO (nothing was staked since the exit) and holds only the recorded AERO, so it takes no fee and sells
      // nothing: it compounds the pool tokens the failed compounding left, which clears the record
      Utils.assertBNEq(await newAero(block), 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee on the recorded AERO");
      // the recorded AERO stays unsold: AERO is no pool token here, so nothing moves it
      assert.equal((await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block })).length, 0,
        "no AERO should leave the strategy");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded);
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
      Utils.assertBNEq(await unstakedLP(), 0);
      // the pool tokens left below 1% of those held: measured 1.6e-6 to 3e-6 of them; compounding only after a reward sale
      // (C5d, which fails the record check above first) leaves all of them. M5, which the volatile suite's twin of this check
      // catches, is equivalent here: AERO is no pool token
      Utils.assertBNGt(held, leftover.times(100));

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      await mineBlocks(600);
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), recorded.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through a hard work that keeps new LP idle (minStakeInterval) after its compounding failed, and takes the fee once with the next one", async function() {
      // a hard work that skips its stake (here the new LP waits for minStakeInterval after the last stake) must not touch the
      // record its own failed compounding just wrote. On this pool the sale sells all the AERO, so the test writes a record
      // below the AERO held into the strategy's storage, as the stale-value tests do: the sale leaves that AERO unsold, and
      // the failed compounding records it again
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      let lastStake = Number((await strategy.lastStakeBlock()).toString());
      assert.notEqual(lastStake, 0, "minStakeInterval counts from the last stake");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      await depositVault(farmer2, underlying, vault, await farmer2LP(10)); // new LP, which the hard work hands to the strategy
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let aeroHeld, block;
      await writeFeePaidReward(recorded);
      try {
        try {
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
          // 0 in this describe (root before()): the default keeps the next stake about a day of blocks after the last one
          await strategy.setMinStakeInterval(432000, { from: governance });
          try {
            await withPoolMintFailing(async () => {
              let failed = await doHardWork();
              assert.isBelow(failed, lastStake + 432000, "should run long before minStakeInterval allows a stake");
              assert.equal((await gaugeEvents("EmissionsClaimed", failed)).length, 1, "should claim");
              Utils.assertBNEq(await feeBase(failed), aeroBefore.plus(await newAero(failed)).minus(recorded));
              assert.equal((await strategyEvents("CompoundFailed", failed)).length, 1, "the compounding should fail without reverting");
              // it skips the stake, with the new LP idle ...
              let idle = new BigNumber(await underlying.balanceOf(strategy.address));
              let skipped = await strategyEvents("StakeSkipped", failed);
              let after = await feePaidReward();
              console.log("stake skipped after a failed compounding: idle LP ", idle.toFixed(), "; AERO kept ", (await aeroToken.balanceOf(strategy.address)).toString(),
                ", recorded as fee-paid ", recorded.toFixed(), " before, ", after.toFixed(), " after");
              assert.equal((await gaugeEvents("Deposit", failed)).length, 0, "should not stake before minStakeInterval");
              Utils.assertBNGt(idle, 0);
              assert.equal(skipped.length, 1, "should skip the stake");
              Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
              // ... and keeps the record the failed compounding wrote
              Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded); // its sale sold all the rest
              assert.equal(after.toFixed(), recorded.toFixed(), "the skipped stake should keep the record the failed compounding wrote");
            });
          } finally {
            await strategy.setMinStakeInterval(0, { from: governance });
          }
        } finally {
          // with minStakeInterval back to 0 and the pool's mint back, the next hard work stakes all the LP, also when a check
          // above fails, so that the tests below find it staked
          aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
          block = await doHardWork();
        }
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      // it takes the fee once: on all the AERO it holds but the recorded AERO (none here), and on what it brings. It sells
      // what the fee left of that only, the recorded AERO stays (no pool token here), and the LP is all staked
      let brought = await newAero(block);
      let sale = await rewardSale(block);
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      console.log("the next run: AERO held ", aeroHeld.toFixed(), " (recorded as fee-paid ", recorded.toFixed(), ") + brought ", brought.toFixed(), ", fee base ",
        sale.feeBase.toFixed(), "; AERO sold ", sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ", aeroKept.toFixed());
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(sale.feeBase, aeroHeld.minus(recorded).plus(brought));
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not recorded as fee-paid");
      assert.equal(aeroKept.toFixed(), recorded.toFixed(), "the recorded AERO should stay unsold");
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything");
      Utils.assertBNEq(await unstakedLP(), 0);

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), recorded.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through a user withdrawal the strategy pays from the gauge, and takes the fee once with the next hard work", async function() {
      // a user withdrawal larger than the LP waiting in the vault has the strategy pay the rest (withdrawToVault), here from
      // the gauge, between a failed compounding and the next hard work: it must not touch the record. On this pool the sale
      // sells all the AERO, so the test writes a record below the AERO held into the strategy's storage, as the stale-value
      // tests do: the sale leaves that AERO unsold, and the failed compounding records it again
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let aeroHeld, block;
      await writeFeePaidReward(recorded);
      try {
        assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
        await withPoolMintFailing(async () => {
          let failed = await doHardWork();
          assert.equal((await strategyEvents("CompoundFailed", failed)).length, 1, "the compounding should fail without reverting");
          Utils.assertBNEq(await feeBase(failed), aeroBefore.plus(await newAero(failed)).minus(recorded));
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded); // its sale sold all the rest
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the failed compounding should keep the record");
        });

        // farmer2 withdraws a tenth of its shares: no LP waits in the vault or in the strategy, so the vault has the strategy
        // pay it (withdrawToVault), from the gauge. The gauge's withdraw pays out the AERO the stake earned since the claim,
        // whose fee is not taken yet
        await mineBlocks(600);
        Utils.assertBNEq(await unstakedLP(), 0);
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        let shares = new BigNumber(await vault.balanceOf(farmer2)).div(10).integerValue(BigNumber.ROUND_DOWN);
        Utils.assertBNGt(shares, 0);
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer2));
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer2 });
        let withdrawal = tx.receipt.blockNumber;
        let paid = (await gaugeEvents("EmissionsClaimed", withdrawal)).reduce((total, claim) => total.plus(claim.args._rewardAmount.toString()), new BigNumber(0));
        console.log("user withdrawal after a failed compounding: LP ", expected.toFixed(), ", AERO the gauge paid out with it ", paid.toFixed(),
          "; recorded as fee-paid ", recorded.toFixed(), " before, ", (await feePaidReward()).toFixed(), " after");
        Utils.assertBNGt(expected, 0);
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer2)).minus(farmerBefore), expected);
        let withdrawn = await gaugeEvents("Withdraw", withdrawal);
        assert.equal(withdrawn.length, 1, "the strategy should pay the withdrawal from the gauge");
        Utils.assertBNEq(withdrawn[0].args._amount.toString(), expected);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked.minus(expected));
        // nothing is sold or compounded in it, and the record stays
        assert.equal((await strategyEvents(profitLogInReward, withdrawal)).length, 0, "a user withdrawal should not sell");
        assert.equal((await poolEvents("Mint", withdrawal, strategy.address)).length, 0, "a user withdrawal should not compound");
        Utils.assertBNGt(paid, 0);
        Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded.plus(paid));
        assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "a user withdrawal should keep the record");

        // the next hard work takes the fee once: on all the AERO it holds but the recorded AERO (the AERO paid out with the
        // withdrawal), and on what it brings. It sells what the fee left of that only, the recorded AERO stays (no pool token
        // here), and the record is cleared
        aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
        block = await doHardWork();
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      let brought = await newAero(block);
      let sale = await rewardSale(block);
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      console.log("the next hard work: AERO held ", aeroHeld.toFixed(), " (recorded as fee-paid ", recorded.toFixed(), ") + brought ", brought.toFixed(), ", fee base ",
        sale.feeBase.toFixed(), "; AERO sold ", sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ", aeroKept.toFixed());
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(sale.feeBase, aeroHeld.minus(recorded).plus(brought));
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not recorded as fee-paid");
      assert.equal(aeroKept.toFixed(), recorded.toFixed(), "the recorded AERO should stay unsold");
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake the LP minted");
      Utils.assertBNEq(await unstakedLP(), 0);

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), recorded.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Keeps feePaidReward through an emergency exit and continueInvesting, and takes the fee once with the next hard work", async function() {
      // governance's emergency exit (a likely reaction to a pool whose mint fails) between a failed compounding and the next
      // hard work takes the whole stake out and pauses investing until continueInvesting: neither may touch the record. On
      // this pool the sale sells all the AERO, so the test writes a record below the AERO held into the strategy's storage,
      // as the stale-value tests do: the sale leaves that AERO unsold, and the failed compounding records it again
      assert.equal((await feePaidReward()).toFixed(), "0", "nothing should be recorded as fee-paid before the test writes a record");
      // AERO for the record to cover: farmer2's (farmer2Aero)
      let sent = new BigNumber("500000000000000000"); // 0.5 AERO
      await farmer2Aero(sent);
      await aeroToken.transfer(strategy.address, sent.toFixed(), { from: farmer2 });
      let recorded = sent.idiv(2);
      await mineBlocks(600); // AERO to claim and sell
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let aeroHeld, block;
      await writeFeePaidReward(recorded);
      try {
        assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the test should write feePaidReward into the strategy's storage");
        await withPoolMintFailing(async () => {
          let failed = await doHardWork();
          assert.equal((await strategyEvents("CompoundFailed", failed)).length, 1, "the compounding should fail without reverting");
          Utils.assertBNEq(await feeBase(failed), aeroBefore.plus(await newAero(failed)).minus(recorded));
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded); // its sale sold all the rest
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "the failed compounding should keep the record");
        });

        // the emergency exit takes the whole stake out through the gauge's normal withdraw, which pays out the AERO the
        // stake earned since the claim (its fee not taken yet), and pauses investing; continueInvesting resumes it
        await mineBlocks(600);
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        try {
          let tx = await strategy.emergencyExit({ from: governance });
          let exit = tx.receipt.blockNumber;
          let paid = (await gaugeEvents("EmissionsClaimed", exit)).reduce((total, claim) => total.plus(claim.args._rewardAmount.toString()), new BigNumber(0));
          console.log("emergency exit after a failed compounding: LP ", staked.toFixed(), ", AERO the gauge paid out with it ", paid.toFixed(),
            "; recorded as fee-paid ", recorded.toFixed(), " before, ", (await feePaidReward()).toFixed(), " after");
          let withdrawn = await gaugeEvents("Withdraw", exit);
          assert.equal(withdrawn.length, 1, "should take the whole stake out through the normal withdraw");
          Utils.assertBNEq(withdrawn[0].args._amount.toString(), staked);
          assert.equal((await gaugeEvents("EmergencyWithdraw", exit)).length, 0);
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          assert.equal(await strategy.pausedInvesting(), true);
          // nothing is sold or compounded in it, and the record stays
          assert.equal((await strategyEvents(profitLogInReward, exit)).length, 0, "an emergency exit should not sell");
          assert.equal((await poolEvents("Mint", exit, strategy.address)).length, 0, "an emergency exit should not compound");
          Utils.assertBNGt(paid, 0);
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), recorded.plus(paid));
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "an emergency exit should keep the record");
          await strategy.continueInvesting({ from: governance });
          assert.equal(await strategy.pausedInvesting(), false);
          assert.equal((await feePaidReward()).toFixed(), recorded.toFixed(), "continueInvesting should keep the record");
        } finally {
          if (await strategy.pausedInvesting()) {
            await strategy.continueInvesting({ from: governance });
          }
          // investing resumed and nothing staked: the next hard work stakes all the LP at once, also when a check above
          // fails, so that the tests below find it staked
          aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
          block = await doHardWork();
        }
        assert.equal((await feePaidReward()).toFixed(), "0", "a compounding that goes through should clear feePaidReward");
      } finally {
        await writeFeePaidReward(0);
      }
      // it takes the fee once: on all the AERO it holds but the recorded AERO (the AERO the exit paid out), and on what it
      // brings. It sells what the fee left of that only, the recorded AERO stays (no pool token here), and the LP is all
      // staked again
      let brought = await newAero(block);
      let sale = await rewardSale(block);
      let aeroKept = new BigNumber(await aeroToken.balanceOf(strategy.address));
      console.log("the first hard work after continueInvesting: AERO held ", aeroHeld.toFixed(), " (recorded as fee-paid ", recorded.toFixed(), ") + brought ",
        brought.toFixed(), ", fee base ", sale.feeBase.toFixed(), "; AERO sold ", sale.sold.toFixed(), " of the ", sale.split.toFixed(), " the fee left; AERO kept ",
        aeroKept.toFixed());
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
      Utils.assertBNEq(sale.feeBase, aeroHeld.minus(recorded).plus(brought));
      assert.equal(sale.sold.toFixed(), sale.split.toFixed(), "the sale should sell all that the fee left of the AERO not recorded as fee-paid");
      assert.equal(aeroKept.toFixed(), recorded.toFixed(), "the recorded AERO should stay unsold");
      assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1, "should compound the pool tokens left");
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake all the LP again");
      Utils.assertBNEq(await unstakedLP(), 0);

      // the next run takes the fee on that AERO, no longer recorded, and on what it brings, and sells all of it
      block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await feeBase(block), recorded.plus(await newAero(block)));
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
      assert.equal((await feePaidReward()).toFixed(), "0");
    });

    it("Reverts the hard work when the zap's swap fails Aero's gas check, while withdrawAll completes without the compounding", async function() {
      // selling off and only pool tokens to compound: the zap's swap is the hard work's first swap through the pool, and
      // fails Aero's pool tape gas check (as if the keeper had sent too little gas there). Re-raised from the compounding
      // as from the AERO sale, it reverts the hard work, so that the keeper retries with more gas
      await strategy.setSell(false, { from: governance });
      try {
        let usdcIn = (await burnLP(2000))[0];
        await usdcToken.transfer(strategy.address, usdcIn.toFixed(), { from: farmer2 });
        await mineBlocks(600); // AERO to claim
        let staked = new BigNumber(await gauge.balanceOf(strategy.address));
        Utils.assertBNGt(staked, 0);
        let before = await gaugeCheckpoint();
        let usdcHeld = new BigNumber(await usdcToken.balanceOf(strategy.address));
        let aeroHeld = new BigNumber(await aeroToken.balanceOf(strategy.address));
        await withPoolTapeFailing(poolFactory.address, async () => {
          let message = await revertMessage(controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice }),
            "the hard work should revert when its zap fails Aero's gas check");
          assert.include(message, revertData(insufficientGasError), "the hard work should revert with Aero's gas check error");
          Utils.assertBNEq(await gauge.userRewardPerTokenPaid(strategy.address), before.paid); // nothing claimed
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
          Utils.assertBNEq(await usdcToken.balanceOf(strategy.address), usdcHeld);
          Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), aeroHeld);

          // withdrawAll goes on without the compounding: it hands all the LP to the vault, and the USDC waits
          let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
          let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
          let failures = await strategyEvents("LiquidationFailed", tx.receipt.blockNumber);
          assert.equal(failures.length, 1, "the liquidation should fail without reverting withdrawAll");
          assert.equal(failures[0].args.reason, insufficientGasError, "Aero's gas check error, from the compounding");
          assert.equal((await strategyEvents("CompoundFailed", tx.receipt.blockNumber)).length, 0, "Aero's gas check error is no compounding failure");
          Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
          Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
          Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
          Utils.assertBNGte(await usdcToken.balanceOf(strategy.address), usdcHeld);
        });

        // with Aero's gas limit back, the next hard work stakes all the LP again, and zaps the USDC
        let block = await doHardWork();
        assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
        assert.equal((await strategyEvents("CompoundFailed", block)).length, 0);
        assert.equal((await poolEvents("Swap", block, strategy.address)).length, 1, "should zap the USDC");
        assert.equal((await poolEvents("Mint", block, strategy.address)).length, 1);
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake everything again");
        Utils.assertBNEq(await unstakedLP(), 0);
      } finally {
        await strategy.setSell(true, { from: governance });
      }

      // selling is back on: the next hard work sells the AERO kept while it was off, all of it (no pool token is AERO)
      let block = await doHardWork();
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 1, "should sell the AERO kept");
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), 0);
    });
  });

  describe("Exit", function() {
    it("Farmer gets back more LP than it deposited", async function() {
      await Utils.advanceNBlock(1800);
      await doHardWork();
      await vault.withdraw(new BigNumber(await vault.balanceOf(farmer1)).toFixed(), { from: farmer1 });
      let farmerNewBalance = new BigNumber(await underlying.balanceOf(farmer1));
      console.log("farmer LP deposited: ", farmerBalance.toFixed(), " withdrawn: ", farmerNewBalance.toFixed());
      Utils.assertBNGt(farmerNewBalance, farmerBalance);
    });
  });

  describe("Pool type", function() {
    it("Rejects a volatile pool at initialization", async function() {
      let volatilePool = await IAeroV2Pool.at(volatilePoolAddress);
      assert.equal(web3.utils.hexToUtf8(await volatilePool.POOL_TYPE()), "V2_VOLATILE");

      // a fresh proxy around a new stable implementation: nothing is initialized yet
      let implementation = await StableStrategy.new();
      let proxy = await StrategyProxy.new(implementation.address);
      let freshStrategy = await StableStrategy.at(proxy.address);

      // the volatile pool with its own gauge: only the pool type is wrong
      let message = await revertMessage(
        freshStrategy.initializeBaseStrategy(addresses.Storage, volatilePoolAddress, vault.address, volatileGaugeAddress, aero, { from: governance }),
        "a volatile pool should be rejected");
      assert.include(message, "Pool type mismatch");

      // the revert came from the pool-type check, not from the initializer: the same proxy accepts the stable pool
      await freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, gaugeAddress, aero, { from: governance });
      assert.equal((await freshStrategy.underlying()).toLowerCase(), underlying.address.toLowerCase());
      assert.equal((await freshStrategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
    });

    it("Rejects a gauge of another pool of the same type at initialization", async function() {
      // the gauge of another stable pool: the pool-type check passes, the gauge check must not
      let otherPool = await IAeroV2Pool.at(await (await IAeroV2Gauge.at(otherGaugeAddress)).stakingToken());
      assert.notEqual(otherPool.address.toLowerCase(), underlying.address.toLowerCase());
      assert.equal(web3.utils.hexToUtf8(await otherPool.POOL_TYPE()), "V2_STABLE");

      // a fresh proxy around a new stable implementation: nothing is initialized yet
      let implementation = await StableStrategy.new();
      let proxy = await StrategyProxy.new(implementation.address);
      let freshStrategy = await StableStrategy.at(proxy.address);

      let message = await revertMessage(
        freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, otherGaugeAddress, aero, { from: governance }),
        "a gauge of another pool should be rejected");
      assert.include(message, "Underlying mismatch");

      // the revert came from the gauge check, not from the initializer: the same proxy accepts the pool's own gauge
      await freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, gaugeAddress, aero, { from: governance });
      assert.equal((await freshStrategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
    });

    it("Fits the strategy's code within EIP-170's 24,576 bytes", async function() {
      // hardhat.config.js lets the test network deploy contracts of any size (allowUnlimitedContractSize), so no other test
      // would notice the strategy growing past what Base deploys
      let implementation = await (await StrategyProxy.at(strategy.address)).implementation();
      let deployed = (await web3.eth.getCode(implementation)).length / 2 - 1;
      let built = Strategy.deployedBytecode.length / 2 - 1;
      console.log("deployed code of the strategy implementation (", Strategy.contractName, "): ", deployed, " bytes (artifact: ", built,
        "), ", 24576 - deployed, " below EIP-170's limit");
      assert.equal(deployed, built, "the proxy should run the implementation built from this artifact");
      assert.isAtMost(deployed, 24576, "the strategy should fit within EIP-170's contract size limit");
    });
  });
});
