//SPDX-License-Identifier: Unlicense
pragma solidity 0.6.12;
pragma experimental ABIEncoderV2;

import "./MoonwellFoldStrategyV2.sol";

contract MoonwellFoldStrategyV2Mainnet_WETH is MoonwellFoldStrategyV2 {

  constructor() public {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0x4200000000000000000000000000000000000006);
    address mToken = address(0x628ff693426583D9a7FB391E54366292F509D457);
    address comptroller = address(0xfBb21d0380beE3312B33c4353c8936a0F13EF26C);
    address well = address(0xFF8adeC2221f9f4D8dfbAFa6B9a297d17603493D);
    address usdc = address(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    MoonwellFoldStrategyV2.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      mToken,
      comptroller,
      usdc,
      790,
      810,
      1000,
      true
    );
    rewardTokens = [well, usdc];
  }
}