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
const IAeroV2Gauge = artifacts.require("IAeroV2Gauge");
const IAeroV2GaugeFactory = artifacts.require("IAeroV2GaugeFactory");
const IAeroV2LeafVoter = artifacts.require("IAeroV2LeafVoter");
const IAeroV2Pool = artifacts.require("IAeroV2Pool");
const StrategyProxy = artifacts.require("StrategyProxy");
const VolatileStrategy = artifacts.require("AerodromeV2VolatileStrategy");

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeV2VolatileStrategyMainnet_AERO_USDC");

// GaugeFactory.sol governance functions that the strategy never calls, so IAeroV2GaugeFactory leaves them out
const gaugeFactoryGovernanceAbi = [
  { type: "function", name: "penaltyConfig", stateMutability: "view", inputs: [], outputs: [{ type: "tuple", name: "",
    components: [{ type: "uint256", name: "minStakeBlocks" }, { type: "uint256", name: "penaltyRate" }] }] },
  { type: "function", name: "setPenaltyConfig", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "uint256", name: "_minStakeBlocksValue" }, { type: "uint256", name: "_penaltyRate" }] },
  { type: "function", name: "setEmissionCap", stateMutability: "nonpayable", outputs: [],
    inputs: [{ type: "address", name: "_gauge" }, { type: "uint128", name: "_cap" }] },
];

// Developed and tested at blockNumber 53206000

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet AerodromeV2 Volatile AERO-USDC", function() {
  let accounts;

  // external contracts
  let underlying;
  let aeroToken;
  let gauge;
  let gaugeFactory;
  let gaugeFactoryGovernance;
  let leafVoter;

  // external setup
  let underlyingWhale = "0xDDcD62f4804Fc8D549feB68C250b2ed7E37b873E"; // its LP is staked in the gauge
  let gaugeAddress = "0xd424BA8ca9d4E278753DE76651a0095451e65cD1";
  let leafVoterAddress = "0x382409fad8503FbCdbB27A4211551fa03e884078";
  let aero = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let volatilePoolFactory = "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2";
  let stablePoolAddress = "0xA5e16dC9A5cae37563116D9407D8C73927675674"; // sAMMV2-USDC/alUSDb, for the pool-type check
  let stableGaugeAddress = "0xBd18BdD2C99cE1C8FaB955451b035CAa03184d75";
  let zeroAddress = "0x0000000000000000000000000000000000000000";
  let penaltyAdmin = "0x42255e3C2d0b71a0b006243148fdF1a71d054cE0"; // Aero Safe: PENALTY_ADMIN_ROLE, CAP_ADMIN_ROLE, GAUGE_TAPE_MANAGER_ROLE, LeafVoter CHAIN_STATUS_ROLE
  let emergencyWithdrawAdmin = "0x15ad691083b3d31ee0ad8664e606febd62cd8892"; // Aero Safe: EMERGENCY_WITHDRAW_ROLE
  let vaultImplementation = "0xC85B44eC8804421F23C0e34f42D054959061B803"; // what MegaFactory deploys
  // Keepers must stay below Aero's MEV-tax threshold (1 gwei on volatile pools); hardhat's 2.5 gwei default would tax our swaps
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
    underlying = await IERC20.at("0xF634058dC94e6BF8e828E27621320C423bC8B18E");
    console.log("Fetching Underlying at: ", underlying.address);
    aeroToken = await IERC20.at(aero);
    gauge = await IAeroV2Gauge.at(gaugeAddress);
    gaugeFactory = await IAeroV2GaugeFactory.at(await gauge.gaugeFactory());
    gaugeFactoryGovernance = new web3.eth.Contract(gaugeFactoryGovernanceAbi, gaugeFactory.address);
    leafVoter = await IAeroV2LeafVoter.at(leafVoterAddress);
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
      ],
      "liquidation": [
        {"aero": [aero, usdc]},
      ],
      "ULOwner": addresses.ULOwner,
    });

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

    it("Claims and stakes at once when Aero removes the window while the strategy is inside one", async function() {
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
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, 7, { from: penaltyAdmin });
      }

      // the window is back, from that new stake
      assert.equal((await strategy.penaltyWindow()).inWindow, true, "should be inside the window again");
    });

    it("With stakeSpacing 1, claims and stakes again in the first hard work after the window", async function() {
      let tx = await strategy.setStakeSpacing(1, { from: governance });
      let changed = await strategyEvents("StakeSpacingChanged", tx.receipt.blockNumber);
      assert.equal(changed.length, 1);
      assert.equal(changed[0].args.stakeSpacing.toString(), "1");
      try {
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
        // long after the default stakeSpacing (70 blocks), still
        await advanceToBlock(block + 699);
        next = await doHardWork();
        assert.equal((await gaugeEvents("EmissionsClaimed", next)).length, 1, "should claim");
        assert.equal((await gaugeEvents("Deposit", next)).length, 0, "should not stake yet");
        let idleBefore = new BigNumber(await underlying.balanceOf(strategy.address));
        Utils.assertBNGt(idleBefore, 0);

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

    it("Keeps new LP unstaked while Aero has switched the gauge off, even when the claim and stakeSpacing allow a stake", async function() {
      let cap = (await gaugeFactory.emissionCap(gaugeAddress)).toString();
      Utils.assertBNGt(cap, 0);
      let block = await claimThenStake(await farmer2LP(10));
      let stakeBlock = await nextStakeBlock();
      assert.equal(stakeBlock, block + 70);
      // past the window and the stakeSpacing of that stake, with new LP
      await advanceToBlock(stakeBlock);
      await depositVault(farmer2, underlying, vault, await farmer2LP(10));

      // Aero switches the gauge off. Only its cap admin can (the cap operator can neither set a 0 cap nor raise one:
      // CapOutOfOperatorRange, NotAuthorized); this also settles the gauge and flushes its fees to the voters
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
      } finally {
        await gaugeFactory.setMinStakeBlocks(gaugeAddress, previousWindow, { from: penaltyAdmin });
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
        // stays in the strategy, not lost
        Utils.assertBNGte(await aeroToken.balanceOf(strategy.address), claimed[0].args._rewardAmount.toString());

        let total = new BigNumber(await vault.underlyingBalanceWithInvestment());
        let tx = await vault.withdrawAll({ from: governance, gasPrice: keeperGasPrice });
        assert.equal((await strategyEvents("LiquidationFailed", tx.receipt.blockNumber)).length, 1);
        Utils.assertBNEq(await gauge.balanceOf(strategy.address), 0);
        Utils.assertBNGte(await vault.underlyingBalanceInVault(), total);
      } finally {
        await controller.setUniversalLiquidator(universalLiquidator, { from: governance });
      }

      // once the route is back, the AERO is sold and the LP staked again
      let aeroBefore = new BigNumber(await aeroToken.balanceOf(strategy.address));
      let block = await doHardWork();
      Utils.assertBNGt(aeroBefore, new BigNumber(await aeroToken.balanceOf(strategy.address)).times(100));
      assert.equal((await gaugeEvents("Deposit", block)).length, 1);
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

        // Aero enables emergencyWithdraw: user withdrawals and emergencyExit go through it
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
    it("Rejects a stable pool at initialization", async function() {
      let stablePool = await IAeroV2Pool.at(stablePoolAddress);
      assert.equal(web3.utils.hexToUtf8(await stablePool.POOL_TYPE()), "V2_STABLE");

      // a fresh proxy around a new volatile implementation: nothing is initialized yet
      let implementation = await VolatileStrategy.new();
      let proxy = await StrategyProxy.new(implementation.address);
      let freshStrategy = await VolatileStrategy.at(proxy.address);

      // the stable pool with its own gauge: only the pool type is wrong
      let message = await revertMessage(
        freshStrategy.initializeBaseStrategy(addresses.Storage, stablePoolAddress, vault.address, stableGaugeAddress, aero, { from: governance }),
        "a stable pool should be rejected");
      assert.include(message, "Pool type mismatch");

      // the revert came from the pool-type check, not from the initializer: the same proxy accepts the volatile pool
      await freshStrategy.initializeBaseStrategy(addresses.Storage, underlying.address, vault.address, gaugeAddress, aero, { from: governance });
      assert.equal((await freshStrategy.underlying()).toLowerCase(), underlying.address.toLowerCase());
      assert.equal((await freshStrategy.rewardPool()).toLowerCase(), gaugeAddress.toLowerCase());
    });
  });
});
