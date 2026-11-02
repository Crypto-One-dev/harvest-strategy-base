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

//const Strategy = artifacts.require("");
const Strategy = artifacts.require("AerodromeV2StableStrategyMainnet_USDC_alUSDb");

// Developed and tested at blockNumber 53206000

// Vanilla Mocha test. Increased compatibility with tools that integrate Mocha.
describe("Base Mainnet AerodromeV2 USDC-alUSDb", function() {
  let accounts;

  // external contracts
  let underlying;
  let gauge;

  // external setup
  let underlyingWhale = "0xEcC0975B80A65668459Fe838497bb1E57d0b3785";
  let aero = "0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee";
  let usdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  let alusdb = "0x877014E21c32feA108B6A1f45f367efc9a2d9B9F";
  let volatilePoolFactory = "0x8E6a9FCd1d638CC760Ffba397605Fe3355dE76D2";
  let stablePoolFactory = "0x78589E876edcEbdce72ee3436ab3c9AD3a7cEF2D";
  // keepers stay below Aero's MEV-tax threshold (1 gwei, as AERO is sold through the volatile AERO/USDC pool);
  // hardhat's default gas price would tax the swaps
  let keeperGasPrice = "100000000";

  // parties in the protocol
  let governance;
  let farmer1;

  // numbers used in tests
  let farmerBalance;

  // Core protocol contracts
  let controller;
  let vault;
  let strategy;

  async function setupExternalContracts() {
    underlying = await IERC20.at("0xA5e16dC9A5cae37563116D9407D8C73927675674");
    console.log("Fetching Underlying at: ", underlying.address);
    gauge = await IAeroV2Gauge.at("0xBd18BdD2C99cE1C8FaB955451b035CAa03184d75");
  }

  async function setupBalance(){
    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: underlyingWhale, value: 10e18});

    // the whale's LP is staked in the gauge
    await gauge.withdraw(await gauge.balanceOf(underlyingWhale), { from: underlyingWhale });
    farmerBalance = await underlying.balanceOf(underlyingWhale);
    await underlying.transfer(farmer1, farmerBalance, { from: underlyingWhale });
  }

  before(async function() {
    governance = addresses.Governance;
    accounts = await web3.eth.getAccounts();

    farmer1 = accounts[1];

    // impersonate accounts
    await impersonates([governance, underlyingWhale, addresses.ULOwner]);

    let etherGiver = accounts[9];
    await web3.eth.sendTransaction({ from: etherGiver, to: governance, value: 10e18});
    await web3.eth.sendTransaction({ from: etherGiver, to: addresses.ULOwner, value: 10e18});

    await setupExternalContracts();
    [controller, vault, strategy] = await setupCoreProtocol({
      "existingVaultAddress": null,
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

    // the strategy ignores the vault's doHardWork while investOnDeposit is on (new vaults start with it on)
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
});
