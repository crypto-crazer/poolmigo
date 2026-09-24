// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/**
 * @title IPositionAdapter
 * @notice Uniform interface the vault uses to operate ONE LP position on ONE pool of ONE DEX.
 *         The vault holds a set of these (see registry in PoolmigoVaultUpgradeable), so it spans
 *         MULTIPLE DEXs and MULTIPLE pools simultaneously.
 *
 *         Adapters speak TOKEN VECTORS (parallel `tokens` / `amounts` arrays), never USD scalars.
 *         Token balances are the ground truth for share accounting; no oracle is load-bearing here.
 *         `position()` reports the venue's state at SPOT (2026-09-22 read-choice decision — a
 *         manipulated or lagged read can only over-price a depositor; `deposit` enforces a non-zero
 *         `minShares`). Price guards live INSIDE adapters only where they still swap (deploy
 *         ratio-adjustment, rebalance).
 * @custom:security-contact security@poolmigo.example
 */
interface IPositionAdapter {
    function dex() external view returns (bytes32);
    function poolId() external view returns (bytes32);

    /// @notice token→amount map of everything this adapter controls, INCLUDING uncollected fees.
    ///         Parallel arrays, index-aligned; token order is stable per adapter.
    function position() external view returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Pull `amounts[i]` of position-token[i] from the vault (approve-pull; the vault
    ///         forceApproves first) and deploy into the position. amounts is aligned to the
    ///         current position() token order.
    function deploy(uint256[] calldata amounts) external returns (address[] memory tokens, uint256[] memory deployed);

    /// @notice Send floor(sharesBps/10_000) of everything this adapter holds, in kind, to `to`.
    function withdrawProportional(uint256 sharesBps, address to)
        external
        returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Collect fees/rewards and send them in kind to the vault; return what was sent.
    function harvest() external returns (address[] memory tokens, uint256[] memory amounts);

    /// @notice Unwind this entire position in kind to `to` (emergency).
    function unwindAll(address to) external returns (address[] memory tokens, uint256[] memory amounts);
}
