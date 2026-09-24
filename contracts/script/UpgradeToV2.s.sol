// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Script, console2} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {PoolmigoVaultV2} from "contracts/PoolmigoVaultV2.sol";

/// @notice Upgrades a live PoolmigoVault proxy to V2. PROXY env = proxy address; owner key signs.
contract UpgradeToV2 is Script {
    function run() external {
        address proxy = vm.envAddress("PROXY");
        Options memory opts;
        opts.unsafeAllow = "missing-initializer,missing-initializer-call";
        vm.startBroadcast();
        Upgrades.upgradeProxy(proxy, "PoolmigoVaultV2.sol", abi.encodeCall(PoolmigoVaultV2.initializeV2, (3600)), opts);
        vm.stopBroadcast();
        console2.log("Upgraded proxy to V2:", proxy);
        console2.log("  new implementation:", Upgrades.getImplementationAddress(proxy));
    }
}
