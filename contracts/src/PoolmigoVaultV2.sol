// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {PoolmigoVaultUpgradeable} from "contracts/PoolmigoVaultUpgradeable.sol";

/**
 * @title PoolmigoVaultV2
 * @notice Example V2 implementation proving the upgrade path of the in-kind basket core is storage-safe.
 *         Appends ONE field to a NEW namespaced storage struct (never touches V1's namespace/layout),
 *         adds a reinitializer to set it, and exposes a version tag + a minRebalanceInterval getter/setter.
 * @dev Storage rule (upgrade skill): V1's ERC-7201 namespace is untouched; V2 uses its OWN namespace, so
 *      there is zero possibility of layout collision. Annotated with @custom:oz-upgrades-from for the plugin.
 * @custom:oz-upgrades-from PoolmigoVaultUpgradeable
 * @custom:security-contact security@poolmigo.example
 */
contract PoolmigoVaultV2 is PoolmigoVaultUpgradeable {
    /// @custom:storage-location erc7201:poolmigo.vault.v2.storage
    struct PoolmigoVaultV2Storage {
        uint64 minRebalanceInterval; // new param introduced in V2
    }

    // keccak256(abi.encode(uint256(keccak256("poolmigo.vault.v2.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOLMIGO_VAULT_V2_STORAGE_LOCATION =
        0x773c086432d2fc50130aed12ad243d0dc896f5f71c80d91bf2045370ba194400;

    event MinRebalanceIntervalSet(uint64 interval);

    function _v2() private pure returns (PoolmigoVaultV2Storage storage $) {
        assembly {
            $.slot := POOLMIGO_VAULT_V2_STORAGE_LOCATION
        }
    }

    /// @notice V2 initializer — runs exactly once on upgrade (reinitializer(2)).
    /// @dev Parent initializers (ERC20/Ownable/etc.) already ran in V1's `initialize` and MUST NOT run
    ///      again — doing so would revert or wipe state. This reinitializer only sets V2's new field.
    function initializeV2(uint64 minRebalanceInterval_) external reinitializer(2) {
        _v2().minRebalanceInterval = minRebalanceInterval_;
        emit MinRebalanceIntervalSet(minRebalanceInterval_);
    }

    function setMinRebalanceInterval(uint64 interval) external onlyOwner {
        _v2().minRebalanceInterval = interval;
        emit MinRebalanceIntervalSet(interval);
    }

    function minRebalanceInterval() external view returns (uint64) {
        return _v2().minRebalanceInterval;
    }

    function version() external pure returns (string memory) {
        return "2.0.0";
    }
}
