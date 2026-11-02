//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeV2StableStrategy.sol";

contract AerodromeV2StableStrategyMainnet_USDC_alUSDb is AerodromeV2StableStrategy {

  constructor() {}

  function initializeStrategy(
    address _storage,
    address _vault
  ) public initializer {
    address underlying = address(0xA5e16dC9A5cae37563116D9407D8C73927675674); // sAMMV2-USDC/alUSDb
    address gauge = address(0xBd18BdD2C99cE1C8FaB955451b035CAa03184d75);
    address aero = address(0x3f5bF3EdAc59d650D8fDf9657a71F2f904A3a4Ee);
    AerodromeV2Strategy.initializeBaseStrategy(
      _storage,
      underlying,
      _vault,
      gauge,
      aero
    );
    address[] memory rewards = new address[](1);
    rewards[0] = aero;
    _setRewardTokens(rewards);
  }
}
