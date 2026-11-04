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

// BaseUpgradeableStrategy and its storage contract both declare events with these names: query the ones the strategy
// emits by their signature
const profitLogInReward = web3.utils.keccak256("ProfitLogInReward(address,uint256,uint256,uint256)");
const profitsNotCollected = web3.utils.keccak256("ProfitsNotCollected(bool,bool)");

// code for a broken Aero contract: every call reverts with 0xdeadbeef
// (PUSH4 0xdeadbeef, PUSH1 0xe0, SHL, PUSH1 0, MSTORE, PUSH1 4, PUSH1 0, REVERT)
const revertingCode = "0x63deadbeef60e01b60005260046000fd";

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
  let leafVoter;
  let poolFeeAccounting;
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
    leafVoter = await IAeroV2LeafVoter.at(leafVoterAddress);
    poolFeeAccounting = new web3.eth.Contract(poolFeeAccountingAbi, underlying.address);
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

  // the first block where the strategy may stake again: its last stake plus stakeSpacing windows
  async function nextStakeBlock() {
    let window = await strategy.penaltyWindow();
    return Number((await gauge.depositBlock(strategy.address)).toString())
      + Number((await strategy.stakeSpacing()).toString()) * Number(window.minStakeBlocks.toString());
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

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];
    farmer2 = accounts[2];

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
      IUniversalLiquidator, IUniversalLiquidatorRegistry, IWETH, StrategyProxy, StableStrategy, controller.constructor,
      vault.constructor, strategy.constructor]) {
      truffleContract.disableConfirmationListener = true;
    }

    // user deposits must wait in the vault until the keeper's hard work (new vaults start with investOnDeposit = true)
    await vault.setInvestOnDeposit(false, { from: governance });

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

        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
        oldSharePrice = new BigNumber(await vault.getPricePerFullShare());
        await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice });
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
    it("Never reach the gauge: the vault's doHardWork is ignored while investOnDeposit is on", async function() {
      // the vault default: user deposits run the strategy's doHardWork
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(2).integerValue(BigNumber.ROUND_DOWN);
        await underlying.approve(vault.address, amount.toFixed(), { from: farmer1 });
        let tx = await vault.deposit(amount.toFixed(), farmer1, { from: farmer1 });
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user deposit should not run the hard work");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user deposit should not reach the gauge");

        // the keeper also comes through the vault, so it is silenced too: the flag must be turned off at deployment
        let block = await doHardWork();
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 1, "keeper hard work should be skipped");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }

      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "keeper hard work should stake");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Never reach the gauge: the vault's doHardWork is ignored while compoundOnWithdraw is on", async function() {
      // with compoundOnWithdraw on, every user withdrawal runs the strategy's doHardWork
      await vault.setCompoundOnWithdraw(true, { from: governance });
      try {
        assert.equal(await vault.compoundOnWithdraw(), true);
        assert.equal(await vault.investOnDeposit(), false, "only compoundOnWithdraw should call for the skip");

        // a deposit waits in the vault, and a smaller withdrawal is paid from it: only the hard work could reach the gauge
        let amount = new BigNumber(await underlying.balanceOf(farmer1)).div(10).integerValue(BigNumber.ROUND_DOWN);
        await depositVault(farmer1, underlying, vault, amount.toFixed());
        let shares = amount.div(2).times(await vault.totalSupply()).idiv(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        assert.equal((await gaugeEvents("Withdraw", tx.receipt.blockNumber)).length, 0, "the withdrawal should be paid from the vault");
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user withdrawal should not run the hard work");
        assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "user withdrawal should not claim");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user withdrawal should not reach the gauge");
      } finally {
        await vault.setCompoundOnWithdraw(false, { from: governance });
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
      // a full exit clears the gauge timer
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), "0");
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

    it("Claims and stakes on every hard work while Aero charges no penalty, even with a window", async function() {
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

        // so every hard work claims and stakes: inside the 7 blocks after the last stake, long before stakeSpacing
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

        // still inside the old 7 blocks and far from the old stakeSpacing, the next hard work claims and stakes
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

    it("Keeps new LP unstaked while Aero has switched the gauge off, even when the claim and stakeSpacing allow a stake", async function() {
      let cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      let block = await claimThenStake(await farmer2LP(10));
      let stakeBlock = await nextStakeBlock();
      assert.equal(stakeBlock, block + 70);
      // past the window and the stakeSpacing of that stake, with new LP
      await advanceToBlock(stakeBlock);
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));

      // Aero switches the gauge off, here as its cap admin (the LeafVoter's emergency council can too). Only its cap admin
      // can switch it back on; the cap operator can neither set a 0 cap nor raise one (CapOutOfOperatorRange,
      // NotAuthorized). This also settles the gauge and flushes its fees to the voters
      await gaugeFactoryGovernance.methods.setEmissionCap(gaugeAddress, 0).send({ from: penaltyAdmin });
      try {
        assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), "0");
        let next = await doHardWork();
        assert.isAtLeast(next, stakeBlock, "should be past stakeSpacing");
        // the claim goes through (it pays the AERO earned before the switch-off) ...
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 0);
        assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        // ... but nothing is staked: the LP waits in the strategy, and no window opens
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
        let idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        let skipped = await strategyEvents("StakeSkipped", next);
        assert.equal(skipped.length, 1);
        Utils.assertBNEq(skipped[0].args.idleAmount.toString(), idle);
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));

        // the same without a window: a switched-off gauge pays no more AERO, so it is never worth staking in
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 0, { from: penaltyAdmin });
        try {
          await assertNoWindow();
          await depositVault(farmer2, underlying, vault, await farmer2LP(10));
          next = await doHardWork();
          assert.equal((await strategyEvents("ClaimFailed", next)).length, 0);
          assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0, "a switched-off gauge should pay no more AERO");
          assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake in a switched-off gauge");
          assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
        } finally {
          await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
        }
      } finally {
        await gaugeFactoryGovernance.methods.setEmissionCap(gaugeAddress, cap).send({ from: penaltyAdmin });
      }

      // switched back on: the next hard work stakes the LP
      assert.equal((await gaugeFactory.emissionCap(gaugeAddress)).toString(), cap);
      let next = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", next)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Runs a hard work that governance calls directly while investOnDeposit is on, under the same window rules", async function() {
      await advanceToBlock(await nextStakeBlock());
      await vault.setInvestOnDeposit(true, { from: governance });
      try {
        // a user deposit moves the LP on to the strategy, but its hard work is skipped, and so is the keeper's
        let amount = await farmer2LP(10);
        await underlying.approve(vault.address, amount, { from: farmer2 });
        let tx = await vault.deposit(amount, farmer2, { from: farmer2 });
        assert.equal((await strategyEvents("HardWorkSkipped", tx.receipt.blockNumber)).length, 1, "user deposit should not run the hard work");
        assert.equal((await gaugeEvents("Deposit", tx.receipt.blockNumber)).length, 0, "user deposit should not reach the gauge");
        Utils.assertBNGte(await underlying.balanceOf(strategy.address), amount);
        let block = await doHardWork();
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 1, "keeper hard work should be skipped");

        // governance calling the strategy itself is not skipped: outside the window and past stakeSpacing, it claims and stakes
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        block = tx.receipt.blockNumber;
        assert.equal((await strategyEvents("HardWorkSkipped", block)).length, 0, "a direct hard work should not be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake right after the claim");
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(block + 7));
        assert.equal(window.inWindow, true, "should be inside the window");

        // inside the window it skips the claim and the stake, like a keeper hard work
        amount = await farmer2LP(10);
        await underlying.approve(vault.address, amount, { from: farmer2 });
        await vault.deposit(amount, farmer2, { from: farmer2 });
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        let next = tx.receipt.blockNumber;
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("HardWorkSkipped", next)).length, 0);
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 0);
        assert.equal((await gaugeEvents("EarlyWithdrawPenalty", next)).length, 0);

        // after the window it claims, and waits for stakeSpacing to stake
        await advanceToBlock(block + 6);
        tx = await strategy.doHardWork({ from: governance, gasPrice: keeperGasPrice });
        next = tx.receipt.blockNumber;
        assert.equal(next, block + 7);
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim after the window");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should still wait for stakeSpacing");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1);
      } finally {
        await vault.setInvestOnDeposit(false, { from: governance });
      }
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
        // one window per stakeSpacing (10) windows: the vault is inside a window a tenth of the time, and a withdrawal
        // there forfeits only what was earned since the window opened, so the loss stays below a tenth of the AERO claimed
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

    it("Lets only the strategy itself run liquidateRewards", async function() {
      // doHardWork and withdrawAllToVault call it on the strategy, so that its failures can be caught
      let message = await revertMessage(strategy.liquidateRewards({ from: governance }), "governance should not run liquidateRewards");
      assert.include(message, "Only self");
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
      // ... then the settings
      let settings = [
        ["continueInvesting", () => strategy.continueInvesting({ from: farmer2 })],
        ["setSell", () => strategy.setSell(false, { from: farmer2 })],
        ["addRewardToken", () => strategy.addRewardToken(weth, { from: farmer2 })],
        ["removeRewardToken", () => strategy.removeRewardToken(weth, { from: farmer2 })],
        ["finalizeUpgrade", () => strategy.finalizeUpgrade({ from: farmer2 })],
      ];
      for (let [name, call] of settings) {
        let message = await revertMessage(call(), "an outsider's " + name + " should revert");
        assert.include(message, notGovernance, name + " should reject an outsider");
      }

      // nothing changed: the stake, its deposit block and so its window, the strategy's settings; nothing reached the gauge
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), staked);
      assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(block));
      let after = await strategy.penaltyWindow();
      assert.equal(after.minStakeBlocks.toString(), window.minStakeBlocks.toString());
      assert.equal(after.penaltyRate.toString(), window.penaltyRate.toString());
      assert.equal(after.windowEndBlock.toString(), String(block + 7));
      assert.equal(await strategy.pausedInvesting(), false);
      assert.equal(await strategy.sell(), true);
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
        let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
        let lpBefore = await unstakedLP();
        let newLP = await farmer2LP(10);
        let block = await claimThenStake(newLP);
        let notCollected = await strategyEvents(profitsNotCollected, block);
        assert.equal(notCollected.length, 1, "should report the profits as not collected");
        assert.equal(notCollected[0].args.sell, false);
        // no fee and no swap: no AERO leaves the strategy, which keeps all it claimed
        assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should take no fee");
        let aeroOut = await aeroToken.getPastEvents("Transfer", { filter: { from: strategy.address }, fromBlock: block, toBlock: block });
        assert.equal(aeroOut.length, 0, "should not sell any AERO");
        let claimed = (await gaugeEvents("EmissionsClaimed", block))[0].args._rewardAmount.toString();
        Utils.assertBNGte(new BigNumber(await aeroToken.balanceOf(strategy.address)).minus(aeroBefore), claimed);
        // and no LP is minted: the stake is only the LP that was already waiting in the vault and the strategy
        Utils.assertBNEq((await gaugeEvents("Deposit", block))[0].args._amount.toString(), lpBefore.plus(newLP));
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
      // deploys a second gauge for this pool. The LeafVoter does not know it (settleGauge returns 0), so it pays no AERO
      let otherFactory = new web3.eth.Contract(gaugeFactoryGovernanceAbi, otherGaugeFactoryAddress);
      assert.equal((await otherFactory.methods.GAUGE_MANAGER().call()).toLowerCase(), gaugeManagerAddress.toLowerCase());
      let secondGaugeAddress = await otherFactory.methods.computeGaugeAddress(underlying.address).call();
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

      // carried over: a stake inside its window, and a stakeSpacing other than the default
      await strategy.setStakeSpacing(12, { from: governance });
      try {
        let block = await claimThenStake(await farmer2LP(10));
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
            staked: (await gauge.balanceOf(strategy.address)).toString(),
            invested: (await strategy.investedUnderlyingBalance()).toString(),
            window: [window.minStakeBlocks.toString(), window.penaltyRate.toString(), window.windowEndBlock.toString(), window.inWindow].join(),
          };
        }
        let before = await snapshot();
        assert.equal(before.window, ["7", "1000000", String(block + 7), true].join());
        await proxy.upgrade({ from: governance });
        assert.equal(await proxy.implementation(), newImplementation.address);
        assert.equal(await strategy.nextImplementation(), zeroAddress, "finalizeUpgrade should clear the schedule");
        assert.equal((await strategy.nextImplementationTimestamp()).toString(), "0");
        assert.deepEqual(await snapshot(), before);

        // the upgraded strategy follows the same rules: it skips inside the window, and stakes 12 windows after the last stake
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let next = await doHardWork();
        assert.isBelow(next, block + 7, "should run inside the window");
        assert.equal((await strategyEvents("ClaimSkipped", next)).length, 1, "claim should be skipped");
        assert.equal((await strategyEvents("StakeSkipped", next)).length, 1, "stake should be skipped");
        assert.equal(await nextStakeBlock(), block + 84);
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

      // nothing was staked, so nothing is claimed: the hard work keeps the dust (no fee, no swap) and stakes
      let block = await doHardWork();
      assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 0);
      assert.equal((await strategyEvents(profitLogInReward, block)).length, 0, "should not sell dust");
      assert.equal((await strategyEvents("LiquidationFailed", block)).length, 0);
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), dust);
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake");

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
      // platform; notifyFee ignores the strategist fee): enough for the fee (:176-179), dust after it (:180-183)
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
      Utils.assertBNEq(await aeroToken.balanceOf(strategy.address), amount.minus(feeOf(amount)));
      // and no LP is minted: the stake is only the LP that was already waiting in the vault and the strategy
      let deposits = await gaugeEvents("Deposit", block);
      assert.equal(deposits.length, 1, "should stake");
      Utils.assertBNEq(deposits[0].args._amount.toString(), lpBefore);
    });

    it("Falls back to emergencyWithdraw only when the gauge withdraw is broken and Aero enabled it", async function() {
      // every gauge withdraw reverts while Aero's LeafVoter is broken: every call to it reverts with 0xdeadbeef
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, "0x63deadbeef60e01b60005260046000fd"]);
      try {
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));

        // emergencyWithdraw disabled: emergencyExit still pauses without reverting, users cannot exit the gauge
        let tx = await strategy.emergencyExit({ from: governance });
        let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
        assert.equal(exitFailures.length, 1);
        assert.equal(exitFailures[0].args.reason, "0xdeadbeef", "the gauge's own revert data");
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        await strategy.continueInvesting({ from: governance });
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert while the gauge is broken");
        assert.include(message, revertData("0xdeadbeef"), "the withdrawal should revert with the gauge's own error");

        // Aero enables emergencyWithdraw on the stable gauge factory: user withdrawals and emergencyExit go through it
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        let expected = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply());
        let farmerBefore = new BigNumber(await underlying.balanceOf(farmer1));
        tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        Utils.assertBNEq(new BigNumber(await underlying.balanceOf(farmer1)).minus(farmerBefore), expected);
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 1);

        await strategy.emergencyExit({ from: governance });
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      } finally {
        // restore Aero
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        await strategy.continueInvesting({ from: governance });
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

        let insufficientGas = revertData(web3.eth.abi.encodeFunctionSignature("InsufficientGasForCall()")); // 0xe28a638c
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }),
          "withdrawal should revert, not fall back to emergencyWithdraw");
        assert.include(message, insufficientGas, "the withdrawal should revert with Aero's gas check error");
        message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert, not silently keep the stake");
        assert.include(message, insufficientGas, "emergencyExit should revert with Aero's gas check error");
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
      // under a window a stake needs the claim to go through first (:127-131). Aero's gas check (recordGaugeTape reverts
      // InsufficientGasForCall while gasleft() <= gaugeTapeGasLimit, GaugeFactory.sol:254-262) runs in both the claim and
      // the deposit (V2Gauge._advanceRewards), with the liquidation in between: for a fixed keeper gas limit, a tape gas
      // limit between the gas left at the claim and the gas left at the deposit fails the deposit only. With 4,000,000 gas
      // these were 3,317,016 and 2,126,098 at this block (bisecting the tape gas limit; the liquidation swaps twice here):
      // 2,720,000 is ~595,000 from both
      let keeperGas = 4000000;
      let tapeGasLimit = 2720000;
      let gaugeTape = await gaugeFactory.gaugeTape();
      let gaugeTapeGasLimit = await gaugeFactory.gaugeTapeGasLimit();
      assert.notEqual(gaugeTape, zeroAddress, "the gas check only runs with a gauge tape");
      await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      let idle;
      try {
        // past the window and the stakeSpacing of the last stake, with new LP: only the deposit can keep it unstaked
        await advanceToBlock(await nextStakeBlock());
        await depositVault(farmer2, underlying, vault, await farmer2LP(10));
        let depositBlock = Number((await gauge.depositBlock(strategy.address)).toString());
        let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));

        await gaugeFactory.setGaugeTape(gaugeTape, tapeGasLimit, { from: penaltyAdmin });
        let tx = await controller.doHardWork(vault.address, { from: governance, gasPrice: keeperGasPrice, gas: keeperGas });
        let block = tx.receipt.blockNumber;
        console.log("keeper gas limit: ", keeperGas, " tape gas limit: ", tapeGasLimit, " (Aero's: ", gaugeTapeGasLimit.toString(),
          ") gas used: ", tx.receipt.gasUsed);
        // the claim passes Aero's gas check ...
        assert.equal((await strategyEvents("ClaimFailed", block)).length, 0, "the claim should pass Aero's gas check");
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        assert.equal((await strategyEvents("StakeSkipped", block)).length, 0, "the claim and stakeSpacing should allow the stake");
        // ... the deposit after the liquidation does not, and fails without reverting
        let failures = await strategyEvents("StakeFailed", block);
        assert.equal(failures.length, 1, "the stake should fail without reverting");
        assert.equal(failures[0].args.reason, web3.eth.abi.encodeFunctionSignature("InsufficientGasForCall()"), "Aero's gas check error");
        assert.equal((await gaugeEvents("Deposit", block)).length, 0);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
        // the LP waits in the strategy, and the gauge is left no allowance to pull it later
        idle = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idle, 0);
        Utils.assertBNEq(await underlying.allowance(strategy.address, gaugeAddress), 0);
        // no new window: the last stake keeps its deposit block, so the next run need not wait for stakeSpacing again
        assert.equal((await gauge.depositBlock(strategy.address)).toString(), String(depositBlock));
        let window = await strategy.penaltyWindow();
        assert.equal(window.windowEndBlock.toString(), String(depositBlock + 7));
        assert.equal(window.inWindow, false, "should be outside the window");

        // with Aero's gas limit back, the next hard work claims and stakes the waiting LP at once
        await gaugeFactory.setGaugeTape(gaugeTape, gaugeTapeGasLimit, { from: penaltyAdmin });
        block = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", block)).length, 1, "should claim");
        let deposits = await gaugeEvents("Deposit", block);
        assert.equal(deposits.length, 1, "should stake the waiting LP");
        Utils.assertBNGte(deposits[0].args._amount.toString(), idle);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        assert.equal((await strategy.penaltyWindow()).windowEndBlock.toString(), String(block + 7));
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

      // the strategy earns pool fees on the LP it holds unstaked: withdrawAll sells the claimed AERO through the pool
      // while all the LP is out of the gauge, and claims fees before that sale, so it leaves the strategy owed fees
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
      // withdrawAll claims the pool fees (:253) before it sells the claimed AERO through the pool (:254) while holding all
      // the LP unstaked: the fees of that sale stay owed to the strategy (two hours of AERO, so that they are not dust)
      await Utils.advanceNBlock(3600);
      let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 1, "the withdrawal should claim");
      assert.equal((await strategyEvents(profitLogInReward, tx.receipt.blockNumber)).length, 1, "should sell the AERO");
      Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
      let pending = await pendingFees();
      console.log("pool fees owed to the strategy after withdrawAll (token0, token1): ", pending.amount0, pending.amount1);
      Utils.assertBNGt(new BigNumber(pending.amount0).plus(pending.amount1), 0);

      // the next withdrawAll, with nothing staked, collects them
      tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
      let claims = await feeClaims(tx.receipt.blockNumber);
      assert.equal(claims.length, 1, "withdrawAll should claim the fees owed");
      Utils.assertBNEq(claims[0].returnValues.amount0, pending.amount0);
      Utils.assertBNEq(claims[0].returnValues.amount1, pending.amount1);
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

      // with nothing staked there is no window and nothing to unstake: the next withdrawAll claims it itself (:252) and
      // sells it
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

    it("Empties the gauge into the vault through emergencyWithdraw only when the gauge withdraw is broken and Aero enabled it", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
      try {
        // emergencyWithdraw disabled: withdrawAll (also used by rebalance and migration) reverts with the gauge's error
        let message = await revertMessage(vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice }),
          "withdrawAll should revert while the gauge is broken");
        assert.include(message, revertData("0xdeadbeef"), "withdrawAll should revert with the gauge's own error");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

        // enabled: all the LP comes back through it, and the claim after it fails without reverting
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        let exits = await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber);
        assert.equal(exits.length, 1, "should exit through emergencyWithdraw");
        Utils.assertBNEq(exits[0].args._amount.toString(), stakedBefore);
        assert.equal((await gaugeEvents("EmissionsClaimed", tx.receipt.blockNumber)).length, 0, "claiming needs the LeafVoter");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      } finally {
        // restore Aero
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
      }

      // with the gauge working again, the next hard work stakes everything
      let block = await doHardWork();
      assert.equal((await gaugeEvents("Deposit", block)).length, 1, "should stake again");
      Utils.assertBNEq(await underlying.balanceOf(strategy.address), 0);
    });

    it("Reverts with emergencyWithdraw's own error when that fails too, and still pauses in an emergency exit", async function() {
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      // emergencyWithdraw does no emission accounting (V2Gauge.sol:110-121), so it can only fail at the LP transfer: here
      // the gauge has lost its LP (moved away by impersonating the gauge), while withdraw fails first, on the LeafVoter
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

        // a user withdrawal reaching the gauge reverts with emergencyWithdraw's error, not with withdraw's (0xdeadbeef)
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let fromGauge = new BigNumber(await vault.underlyingBalanceWithInvestment()).times(shares).idiv(await vault.totalSupply())
          .minus(await unstakedLP());
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert when both exits fail");
        assert.include(message, revertData(insufficientBalance(fromGauge.toFixed())), "the withdrawal should revert with emergencyWithdraw's error");

        // an emergency exit still pauses investing, and reports that error; the stake stays in the gauge's books
        let tx = await strategy.emergencyExit({ from: governance });
        let exitFailures = await strategyEvents("GaugeExitFailed", tx.receipt.blockNumber);
        assert.equal(exitFailures.length, 1);
        assert.equal(exitFailures[0].args.reason, insufficientBalance(stakedBefore.toFixed()), "should report emergencyWithdraw's error");
        assert.equal(await strategy.pausedInvesting(), true, "investing should be paused");
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);
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

    it("Currently treats a gauge failure without revert data as a gas failure: no emergencyWithdraw fallback", async function() {
      // documents current behaviour, still under review: _isGasFailure takes empty revert data for an out-of-gas, so an
      // Aero failure that returns no data (here the LeafVoter hits INVALID) blocks exits even with emergencyWithdraw enabled
      let stakedBefore = new BigNumber(await gauge.balanceOf(strategy.address));
      Utils.assertBNGt(stakedBefore, 0);
      let leafVoterCode = await web3.eth.getCode(leafVoterAddress);
      try {
        await gaugeFactory.setEmergencyWithdrawEnabled(true, { from: emergencyWithdrawAdmin });
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, "0xfe"]); // INVALID: no revert data
        let shares = new BigNumber(await vault.balanceOf(farmer1)).div(4).integerValue(BigNumber.ROUND_DOWN);
        let message = await revertMessage(vault.withdraw(shares.toFixed(), { from: farmer1 }), "withdrawal should revert, not fall back to emergencyWithdraw");
        assert.include(message, "Transaction reverted without a reason string", "the withdrawal should revert with no data, as the gauge did");
        message = await revertMessage(strategy.emergencyExit({ from: governance }), "emergencyExit should revert, not pause without exiting");
        assert.include(message, "Transaction reverted without a reason string", "emergencyExit should revert with no data, as the gauge did");
        assert.equal(await strategy.pausedInvesting(), false);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), stakedBefore);

        // the same broken LeafVoter with revert data: the same withdrawal goes through emergencyWithdraw
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, revertingCode]);
        let tx = await vault.withdraw(shares.toFixed(), { from: farmer1 });
        assert.equal((await gaugeEvents("EmergencyWithdraw", tx.receipt.blockNumber)).length, 1, "should fall back to emergencyWithdraw");
      } finally {
        // restore Aero (and investing, had emergencyExit gone through)
        await hre.network.provider.send("hardhat_setCode", [leafVoterAddress, leafVoterCode]);
        await gaugeFactory.setEmergencyWithdrawEnabled(false, { from: emergencyWithdrawAdmin });
        if (await strategy.pausedInvesting()) {
          await strategy.continueInvesting({ from: governance });
        }
      }
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
  });
});
