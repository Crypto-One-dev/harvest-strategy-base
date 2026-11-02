//SPDX-License-Identifier: Unlicense
pragma solidity 0.8.26;

import "./AerodromeV2Strategy.sol";

/**
 * @title AerodromeV2StableStrategy
 * @dev AerodromeV2Strategy for Aero Basic Stable pools (sAMMV2-*, x^3*y + y^3*x = k). All logic is shared with
 * AerodromeV2VolatileStrategy; initialization rejects any pool that is not a stable one.
 */
contract AerodromeV2StableStrategy is AerodromeV2Strategy {
  function _poolType() internal pure override returns (bytes32) {
    return "V2_STABLE";
  }
}
