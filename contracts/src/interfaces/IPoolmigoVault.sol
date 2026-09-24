// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/**
 * @title IPoolmigoVault
 * @notice External surface of the Poolmigo LP auto-rebalance vault. Multi-DEX, multi-pool, upgradeable.
 *         In-kind, multi-asset basket model: migoLP is a pro-rata claim on a basket of tokens.
 * @custom:security-contact security@poolmigo.example
 */
interface IPoolmigoVault {
    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    // Basket registry
    event TokenAdded(address indexed token);

    // User flows (in kind — parallel token/amount vectors)
    event Deposited(
        address indexed sender, address indexed receiver, address[] tokens, uint256[] amounts, uint256 shares
    );
    event Redeemed(
        address indexed sender, address indexed receiver, uint256 shares, address[] tokens, uint256[] amounts
    );

    // Keeper / strategy flows
    event Deployed(address indexed keeper, address indexed adapter, address[] tokens, uint256[] amounts);
    event PulledFrom(
        address indexed keeper, address indexed adapter, uint256 sharesBps, address[] tokens, uint256[] amounts
    );
    event Rebalanced(address indexed keeper, address[] tokens, uint256[] harvested, uint256[] fees);
    event PerformanceFeeAccrued(address indexed treasury, address[] tokens, uint256[] fees);
    event EmergencyUnwound(address indexed owner, address[] tokens, uint256[] amounts);

    // Registry (multi-DEX / multi-pool) events
    event AdapterAdded(address indexed adapter, bytes32 indexed dex, bytes32 indexed poolId);
    event AdapterRemoved(address indexed adapter);

    // Governance / parameter events
    event KeeperSet(address indexed keeper, bool allowed);
    event TreasurySet(address indexed oldTreasury, address indexed newTreasury);
    event PerformanceFeeSet(uint16 oldBps, uint16 newBps);
    event RebalancePaused(bool paused);
    event MaxTotalSupplySet(uint256 oldCap, uint256 newCap);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error PoolmigoVault__ZeroAddress();
    error PoolmigoVault__ZeroAmount();
    error PoolmigoVault__ZeroShares();
    error PoolmigoVault__FeeTooHigh(uint16 bps, uint16 maxBps);
    error PoolmigoVault__NotKeeper();
    error PoolmigoVault__RebalancePaused();
    error PoolmigoVault__NoAdapters();
    error PoolmigoVault__LengthMismatch();
    error PoolmigoVault__InsufficientShares(uint256 held, uint256 shares);
    error PoolmigoVault__InsufficientSharesOut(uint256 minShares, uint256 actualShares);
    error PoolmigoVault__ZeroMinShares();
    error PoolmigoVault__InsufficientIdle(address token, uint256 available, uint256 requested);
    error PoolmigoVault__InvalidSharesBps(uint256 sharesBps);

    // Genesis + supply cap
    error PoolmigoVault__ZeroGenesisShares();
    error PoolmigoVault__GenesisNotOwner();
    error PoolmigoVault__SupplyCapExceeded(uint256 newSupply, uint256 cap);
    error PoolmigoVault__InvalidSupplyCap(uint256 cap, uint256 minimum);

    // Basket registry
    error PoolmigoVault__TokenNotRegistered(address token);
    error PoolmigoVault__TokenAlreadyRegistered(address token);
    error PoolmigoVault__MaxTokensReached(uint256 max);
    error PoolmigoVault__DuplicateToken(address token);
    error PoolmigoVault__MissingBasketToken(address token);

    // Adapter registry
    error PoolmigoVault__AdapterNotRegistered(address adapter);
    error PoolmigoVault__AdapterAlreadyRegistered(address adapter);
    error PoolmigoVault__MaxAdaptersReached(uint256 max);
    error PoolmigoVault__AdapterNoTokens(address adapter);
    error PoolmigoVault__AdapterTokenNotRegistered(address adapter, address token);
    error PoolmigoVault__AdapterStillFunded(address adapter, address token, uint256 amount);
}
