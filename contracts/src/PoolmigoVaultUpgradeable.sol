// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    ReentrancyGuardTransientUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IPoolmigoVault} from "contracts/interfaces/IPoolmigoVault.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";

/**
 * @title PoolmigoVaultUpgradeable
 * @author Poolmigo
 * @notice Multi-DEX, multi-pool LP auto-rebalance vault for EVM chains (first deployment target:
 *         Robinhood Chain, chainId 4663).
 *         UUPS-upgradeable, ERC-7201 namespaced storage.
 *
 *         In-kind, multi-asset BASKET model:
 *         - migoLP is a pro-rata claim on a basket of tokens (e.g. USDG + WETH), NOT a USD-denominated claim.
 *         - Deposits are in kind and strictly same-proportion: the user offers basket tokens, the vault
 *           computes shares from the BINDING token (min ratio) and pulls only what that share count
 *           requires. Excess is never pulled. No swaps.
 *         - Redemptions are in kind: the user receives their pro-rata slice of EVERY basket token,
 *           straight from idle balances and from each adapter. No swaps. Works while paused.
 *         - Adapters speak token vectors, never USD scalars. Token balances ARE the ground truth for
 *           share accounting; no oracle is load-bearing here. TWAP guards live inside adapters only.
 *         - Performance fee is charged in kind, per token, ONLY on harvested fees/rewards — never principal.
 *         - Upgrade authority is `owner` (MUST be a multisig behind a timelock on mainnet).
 *
 * @dev Get an audit before mainnet. Adapters are trusted, owner-registered venue wrappers.
 * @custom:security-contact security@poolmigo.example
 */
contract PoolmigoVaultUpgradeable is
    IPoolmigoVault,
    Initializable,
    ERC20Upgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;
    using Math for uint256;

    /*//////////////////////////////////////////////////////////////
                               CONSTANTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Hard ceiling on the performance fee; owner can never exceed this.
    uint16 public constant MAX_PERFORMANCE_FEE_BPS = 3000; // 30%
    uint16 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Bound on registered positions — keeps rebalance/redeem loops gas-safe.
    uint256 public constant MAX_ADAPTERS = 32;
    /// @notice Bound on basket tokens — keeps per-token loops gas-safe.
    uint256 public constant MAX_TOKENS = 8;
    /// @dev Sentinel for "token not found in registry" during in-memory scans.
    uint256 private constant NOT_FOUND = type(uint256).max;
    /// @dev Virtual shares / virtual assets (donation / inflation guard) — applied to the DEPOSIT
    ///      conversion only: shares = floor(amount * (S + VIRTUAL_SHARES) / (T + VIRTUAL_ASSETS)).
    ///      Redemption stays REAL pro-rata. VIRTUAL_ASSETS is per basket token (1 raw unit each).
    ///
    ///      Final values VS = VA = 1 (OZ ERC-4626's default offset-0 ratio), tuned DOWN from the 1e6/1
    ///      starting point because the deposit side is virtual but redeem is real: a deposit→redeem
    ///      round trip on token i returns <= what was pulled iff VS/VA <= S/T_i (shares per raw unit).
    ///      At the ≈$1/share genesis scale, S/T_i ≈ price_i * 1e18 / 10^dec_i — ~1e3 for an 18-dp WETH
    ///      leg — so VS = 1e6 let the WETH leg round-trip up to +997 wei (fuzz counterexample; the
    ///      demo-scale sweep also gained). VS = 1 holds for every token priced >= 1 display unit per
    ///      whole token; below that (18-dp micro-price tokens) the residual is < 1 share-wei of value.
    ///      The donation / inflation defence does not rest on the virtual size: genesis is owner-gated
    ///      with a large K, and deposits pull only ceil(shares * (T + VA) / (S + VS)), so a depositor
    ///      pays for exactly the shares it receives. At a degenerate 1-share-wei supply, VS = 1 still
    ///      makes a donating sole holder strictly lose (tests: test_DonationInflation_*).
    uint256 private constant VIRTUAL_SHARES = 1;
    uint256 private constant VIRTUAL_ASSETS = 1;

    /*//////////////////////////////////////////////////////////////
                        ERC-7201 NAMESPACED STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @custom:storage-location erc7201:poolmigo.vault.storage
    struct PoolmigoVaultStorage {
        address treasury; // performance-fee recipient (multisig)
        uint16 performanceFeeBps; // fee on harvested fees/rewards only, charged in kind
        bool rebalancePaused; // blocks deposits + deploy + rebalance; redemptions stay open
        address[] tokens; // basket registry, owner-managed, <= MAX_TOKENS
        mapping(address token => bool registered) isToken;
        IPositionAdapter[] adapters; // registry of live positions (multi-DEX / multi-pool)
        mapping(address adapter => bool registered) isAdapter;
        mapping(address keeper => bool allowed) isKeeper;
        uint256 genesisShares; // K: shares minted by the (owner-gated) genesis deposit; fixes the display scale
        uint256 maxTotalSupply; // migoLP supply cap (PRD F1.2); 0 = uncapped
    }

    // keccak256(abi.encode(uint256(keccak256("poolmigo.vault.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant POOLMIGO_VAULT_STORAGE_LOCATION =
        0xac5b1d856d96bdb992e4d284c4f305568246dd601ded20a127e04a49bd0b7b00;

    function _s() private pure returns (PoolmigoVaultStorage storage $) {
        assembly {
            $.slot := POOLMIGO_VAULT_STORAGE_LOCATION
        }
    }

    /*//////////////////////////////////////////////////////////////
                                MODIFIERS
    //////////////////////////////////////////////////////////////*/

    modifier onlyKeeper() {
        if (!_s().isKeeper[msg.sender]) {
            revert PoolmigoVault__NotKeeper();
        }
        _;
    }

    /*//////////////////////////////////////////////////////////////
                             INITIALIZATION
    //////////////////////////////////////////////////////////////*/

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers(); // lock the implementation; only proxies get initialized
    }

    /**
     * @notice Initialize the proxy. Replaces the constructor for upgradeable deployment.
     * @param owner_ Vault owner + upgrade authority — MUST be a multisig (behind timelock) on mainnet.
     * @param tokens_ Initial basket registry (non-empty, no zero addresses, no duplicates, <= MAX_TOKENS).
     * @param treasury_ Performance-fee recipient (multisig).
     * @param performanceFeeBps_ Initial performance fee (bps), <= MAX_PERFORMANCE_FEE_BPS.
     * @param genesisShares_ K — shares minted by the owner-gated genesis deposit (non-zero). Chosen
     *        against a manual, one-time, off-chain valuation of the seed basket so the display scale
     *        starts at ≈$1/share; the contract never prices anything.
     * @param maxTotalSupply_ migoLP supply cap (0 = uncapped); if set, must be >= `genesisShares_`.
     */
    function initialize(
        address owner_,
        address[] calldata tokens_,
        address treasury_,
        uint16 performanceFeeBps_,
        uint256 genesisShares_,
        uint256 maxTotalSupply_
    ) external initializer {
        if (owner_ == address(0) || treasury_ == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if (performanceFeeBps_ > MAX_PERFORMANCE_FEE_BPS) {
            revert PoolmigoVault__FeeTooHigh(performanceFeeBps_, MAX_PERFORMANCE_FEE_BPS);
        }
        if (genesisShares_ == 0) {
            revert PoolmigoVault__ZeroGenesisShares();
        }
        if (maxTotalSupply_ != 0 && maxTotalSupply_ < genesisShares_) {
            revert PoolmigoVault__InvalidSupplyCap(maxTotalSupply_, genesisShares_);
        }
        uint256 n = tokens_.length;
        if (n == 0) {
            revert PoolmigoVault__LengthMismatch();
        }
        if (n > MAX_TOKENS) {
            revert PoolmigoVault__MaxTokensReached(MAX_TOKENS);
        }

        __ERC20_init("migoLP", "migoLP");
        __Ownable_init(owner_);
        __Ownable2Step_init();
        __ReentrancyGuardTransient_init();
        __UUPSUpgradeable_init();

        PoolmigoVaultStorage storage $ = _s();
        $.treasury = treasury_;
        $.performanceFeeBps = performanceFeeBps_;
        $.genesisShares = genesisShares_;
        $.maxTotalSupply = maxTotalSupply_;
        emit MaxTotalSupplySet(0, maxTotalSupply_);
        for (uint256 i; i < n; ++i) {
            _addToken($, tokens_[i]);
        }
    }

    /*//////////////////////////////////////////////////////////////
                    USER-FACING STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Deposit basket tokens in kind and mint migoLP shares to `receiver`.
     * @dev STRICT same-proportion rule, no swaps:
     *      - Genesis (totalSupply == 0): OWNER ONLY (`PoolmigoVault__GenesisNotOwner` otherwise) — the
     *        team's ONE controlled seed. `tokens_` must cover the FULL registry, every amount > 0, every
     *        amount is pulled in full, and `shares = genesisShares` (K, fixed at initialize). The team's
     *        manual (off-chain, one-time, no oracle) valuation of the seed basket versus K fixes the
     *        display scale (≈$1/share); afterwards the scale never changes — every later deposit and
     *        redemption is a pure ratio. If supply ever returns to 0 (full redemption) this branch
     *        re-arms with the same stored K, owner-gated again.
     *      - Normal: every registry token the vault currently holds MUST be offered (amount > 0).
     *        shares = min_i floor(amount_i * (S + VS) / (T_i + VA)); required_i =
     *        ceil(shares * (T_i + VA) / (S + VS)) is pulled per token (VS/VA = virtual shares/assets,
     *        the donation guard — see the constants). Any offer above `required_i` is simply never
     *        pulled (no refund transfer needed). Tokens the vault does not hold (T_i == 0) pull 0.
     *      Reverts `PoolmigoVault__SupplyCapExceeded` if a non-zero `maxTotalSupply` would be exceeded
     *      (genesis included).
     *      Reverts with `PoolmigoVault__InsufficientSharesOut` when the computable `shares` is below
     *      `minShares` — depositor slippage protection; nothing is pulled on that revert.
     *      `minShares == 0` reverts `PoolmigoVault__ZeroMinShares` (enforced non-zero; at genesis the
     *      owner knows `shares == genesisShares` upfront).
     * @param tokens_ Tokens offered (any order, no duplicates, all registered).
     * @param amounts_ Max amount offered per token, aligned to `tokens_`.
     * @param minShares Minimum acceptable shares minted — MANDATORY, must be non-zero. The
     *        deposit-pricing read can only over-price (research/spot-read/findings.md), so this
     *        bound is the depositor's protection.
     * @param receiver Recipient of the minted shares.
     * @return shares Shares minted.
     */
    function deposit(address[] calldata tokens_, uint256[] calldata amounts_, uint256 minShares, address receiver)
        external
        nonReentrant
        returns (uint256 shares)
    {
        if (receiver == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if (minShares == 0) {
            revert PoolmigoVault__ZeroMinShares();
        }
        if (_s().rebalancePaused) {
            revert PoolmigoVault__RebalancePaused();
        }

        uint256[] memory required;
        (shares, required) = _previewDeposit(tokens_, amounts_);
        if (shares < minShares) {
            revert PoolmigoVault__InsufficientSharesOut(minShares, shares);
        }

        // Pull only what the share count requires; excess offered stays with the sender.
        uint256 n = tokens_.length;
        for (uint256 i; i < n; ++i) {
            if (required[i] != 0) {
                IERC20(tokens_[i]).safeTransferFrom(msg.sender, address(this), required[i]);
            }
        }
        _mint(receiver, shares);

        emit Deposited(msg.sender, receiver, tokens_, required, shares);
    }

    /**
     * @notice Burn `shares` and send the pro-rata slice of EVERY basket token, in kind, to `receiver`.
     * @dev Always available, even while paused; no oracle, no swaps, and NO adapter reports needed —
     *      a position that cannot report can never block a redemption. Each adapter delivers
     *      floor(sharesBps / 10_000) of everything it holds straight to `receiver`; the vault delivers
     *      floor(shares * idle / totalSupply) of its own balances. The bps flooring on the adapter side
     *      leaves up to ~1bp of the adapter-held slice in place for the remaining holders (documented
     *      dust convention; the vault never over-delivers).
     * @return tokens_ Registry tokens.
     * @return amounts Amount of each token actually delivered to `receiver`.
     */
    function redeem(uint256 shares, address receiver)
        external
        nonReentrant
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        if (shares == 0) {
            revert PoolmigoVault__ZeroShares();
        }
        if (receiver == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        uint256 held = balanceOf(msg.sender);
        if (held < shares) {
            revert PoolmigoVault__InsufficientShares(held, shares);
        }

        uint256 supplyBefore = totalSupply();
        uint256 sharesBps = shares.mulDiv(BPS_DENOMINATOR, supplyBefore, Math.Rounding.Floor);

        PoolmigoVaultStorage storage $ = _s();
        tokens_ = $.tokens;
        uint256 n = tokens_.length;

        // Snapshot the exact idle slice BEFORE any interaction (pro-rata of the vault's own balances).
        uint256[] memory idleOut = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            idleOut[i] = shares.mulDiv(IERC20(tokens_[i]).balanceOf(address(this)), supplyBefore, Math.Rounding.Floor);
        }

        // Effects before interactions.
        _burn(msg.sender, shares);

        amounts = new uint256[](n);
        if (sharesBps != 0) {
            uint256 len = $.adapters.length;
            for (uint256 i; i < len; ++i) {
                (address[] memory t, uint256[] memory a) = $.adapters[i].withdrawProportional(sharesBps, receiver);
                _accumulate(tokens_, amounts, t, a);
            }
        }
        for (uint256 i; i < n; ++i) {
            if (idleOut[i] != 0) {
                IERC20(tokens_[i]).safeTransfer(receiver, idleOut[i]);
                amounts[i] += idleOut[i];
            }
        }

        emit Redeemed(msg.sender, receiver, shares, tokens_, amounts);
    }

    /*//////////////////////////////////////////////////////////////
                        KEEPER (STRATEGY) FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Keeper deploys idle vault tokens into a specific registered position.
     * @dev Which pool, how much, and when are off-chain strategy decisions; this just moves funds into a
     *      venue the owner has whitelisted. Approves exactly `amounts`, lets the adapter pull, then zeroes
     *      every approval. `amounts` is aligned to the adapter's current `position()` token order.
     */
    function deployTo(IPositionAdapter adapter, uint256[] calldata amounts) external nonReentrant onlyKeeper {
        PoolmigoVaultStorage storage $ = _s();
        if (!$.isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterNotRegistered(address(adapter));
        }
        if ($.rebalancePaused) {
            revert PoolmigoVault__RebalancePaused();
        }

        (address[] memory t,) = adapter.position();
        uint256 n = t.length;
        if (amounts.length != n) {
            revert PoolmigoVault__LengthMismatch();
        }
        for (uint256 i; i < n; ++i) {
            if (!$.isToken[t[i]]) {
                revert PoolmigoVault__AdapterTokenNotRegistered(address(adapter), t[i]);
            }
            uint256 idle = IERC20(t[i]).balanceOf(address(this));
            if (amounts[i] > idle) {
                revert PoolmigoVault__InsufficientIdle(t[i], idle, amounts[i]);
            }
        }

        for (uint256 i; i < n; ++i) {
            IERC20(t[i]).forceApprove(address(adapter), amounts[i]);
        }
        adapter.deploy(amounts);
        for (uint256 i; i < n; ++i) {
            IERC20(t[i]).forceApprove(address(adapter), 0);
        }

        emit Deployed(msg.sender, address(adapter), t, amounts);
    }

    /**
     * @notice Keeper pulls `sharesBps / 10_000` of a registered position back into the vault, in kind.
     * @dev `pullFrom` + {deployTo} together express "pull from venue A, deploy to venue B" re-shaping
     *      (range / venue moves) entirely on-chain, with no owner step. The destination is HARD-WIRED to
     *      the vault — it is never a parameter, so this can never become a fund-egress path. Token
     *      balances simply move between adapter and idle; `totalTokens()` is unchanged (modulo the
     *      adapter's bps flooring). Blocked while paused, like every keeper action.
     * @param adapter Registered position to pull from.
     * @param sharesBps Fraction of the position to pull, in bps (1..10_000; 10_000 = everything).
     * @return tokens_ Tokens the adapter delivered (adapter order).
     * @return amounts Amounts the adapter delivered to the vault, aligned to `tokens_`.
     */
    function pullFrom(IPositionAdapter adapter, uint256 sharesBps)
        external
        nonReentrant
        onlyKeeper
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        PoolmigoVaultStorage storage $ = _s();
        if (!$.isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterNotRegistered(address(adapter));
        }
        if ($.rebalancePaused) {
            revert PoolmigoVault__RebalancePaused();
        }
        if (sharesBps == 0 || sharesBps > BPS_DENOMINATOR) {
            revert PoolmigoVault__InvalidSharesBps(sharesBps);
        }

        (tokens_, amounts) = adapter.withdrawProportional(sharesBps, address(this));

        emit PulledFrom(msg.sender, address(adapter), sharesBps, tokens_, amounts);
    }

    /**
     * @notice Keeper-triggered rebalance tick: harvest ALL positions, skim the perf fee in kind per token.
     * @dev Adapters send harvested tokens straight to the vault; the fee is charged on the COMBINED
     *      harvest across all adapters. Position re-shaping lives off-chain / in adapters.
     * @return tokens_ Registry tokens.
     * @return harvested Total harvested per token across all positions.
     * @return fees Fee sent to treasury per token.
     */
    function rebalance()
        external
        nonReentrant
        onlyKeeper
        returns (address[] memory tokens_, uint256[] memory harvested, uint256[] memory fees)
    {
        PoolmigoVaultStorage storage $ = _s();
        if ($.rebalancePaused) {
            revert PoolmigoVault__RebalancePaused();
        }
        uint256 len = $.adapters.length;
        if (len == 0) {
            revert PoolmigoVault__NoAdapters();
        }

        tokens_ = $.tokens;
        uint256 n = tokens_.length;
        harvested = new uint256[](n);
        fees = new uint256[](n);

        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = $.adapters[i].harvest();
            _accumulate(tokens_, harvested, t, a);
        }

        uint16 feeBps = $.performanceFeeBps;
        address treasury_ = $.treasury;
        bool anyFee;
        for (uint256 i; i < n; ++i) {
            uint256 fee = harvested[i].mulDiv(feeBps, BPS_DENOMINATOR, Math.Rounding.Floor);
            if (fee != 0) {
                fees[i] = fee;
                anyFee = true;
                IERC20(tokens_[i]).safeTransfer(treasury_, fee);
            }
        }
        if (anyFee) {
            emit PerformanceFeeAccrued(treasury_, tokens_, fees);
        }

        emit Rebalanced(msg.sender, tokens_, harvested, fees);
    }

    /*//////////////////////////////////////////////////////////////
                        OWNER / GOVERNANCE FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Register a new basket token. No removal in this phase.
    function addToken(address token) external onlyOwner {
        _addToken(_s(), token);
    }

    /// @notice Register a new position (a DEX+pool adapter). Every token it reports must be in the basket.
    function addAdapter(IPositionAdapter adapter) external onlyOwner {
        if (address(adapter) == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        PoolmigoVaultStorage storage $ = _s();
        if ($.isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterAlreadyRegistered(address(adapter));
        }
        if ($.adapters.length >= MAX_ADAPTERS) {
            revert PoolmigoVault__MaxAdaptersReached(MAX_ADAPTERS);
        }
        (address[] memory t,) = adapter.position();
        uint256 n = t.length;
        if (n == 0) {
            revert PoolmigoVault__AdapterNoTokens(address(adapter));
        }
        for (uint256 i; i < n; ++i) {
            if (t[i] == address(0)) {
                revert PoolmigoVault__ZeroAddress();
            }
            if (!$.isToken[t[i]]) {
                revert PoolmigoVault__AdapterTokenNotRegistered(address(adapter), t[i]);
            }
        }
        $.isAdapter[address(adapter)] = true;
        $.adapters.push(adapter);
        emit AdapterAdded(address(adapter), adapter.dex(), adapter.poolId());
    }

    /// @notice Remove a position. Must be emptied first (unwound) so no value is orphaned.
    function removeAdapter(IPositionAdapter adapter) external onlyOwner {
        PoolmigoVaultStorage storage $ = _s();
        if (!$.isAdapter[address(adapter)]) {
            revert PoolmigoVault__AdapterNotRegistered(address(adapter));
        }
        (address[] memory t, uint256[] memory a) = adapter.position();
        uint256 n = t.length;
        for (uint256 i; i < n; ++i) {
            if (a[i] != 0) {
                revert PoolmigoVault__AdapterStillFunded(address(adapter), t[i], a[i]);
            }
        }
        $.isAdapter[address(adapter)] = false;

        IPositionAdapter[] storage arr = $.adapters;
        uint256 len = arr.length;
        for (uint256 i; i < len; ++i) {
            if (address(arr[i]) == address(adapter)) {
                arr[i] = arr[len - 1];
                arr.pop();
                break;
            }
        }
        emit AdapterRemoved(address(adapter));
    }

    /// @notice Pause/unpause deposits, deploys + rebalances. Redemptions remain open regardless.
    function setRebalancePaused(bool paused) external onlyOwner {
        _s().rebalancePaused = paused;
        emit RebalancePaused(paused);
    }

    /**
     * @notice Emergency: unwind ALL positions in kind back to the vault, then pause. Owner = multisig.
     * @return tokens_ Registry tokens.
     * @return amounts Amount of each token pulled back into the vault.
     */
    function emergencyUnwind()
        external
        nonReentrant
        onlyOwner
        returns (address[] memory tokens_, uint256[] memory amounts)
    {
        PoolmigoVaultStorage storage $ = _s();
        $.rebalancePaused = true;
        emit RebalancePaused(true);

        tokens_ = $.tokens;
        amounts = new uint256[](tokens_.length);
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = $.adapters[i].unwindAll(address(this));
            _accumulate(tokens_, amounts, t, a);
        }
        emit EmergencyUnwound(msg.sender, tokens_, amounts);
    }

    /// @notice Set performance fee (bps). Hard-capped by MAX_PERFORMANCE_FEE_BPS.
    function setPerformanceFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > MAX_PERFORMANCE_FEE_BPS) {
            revert PoolmigoVault__FeeTooHigh(newBps, MAX_PERFORMANCE_FEE_BPS);
        }
        PoolmigoVaultStorage storage $ = _s();
        emit PerformanceFeeSet($.performanceFeeBps, newBps);
        $.performanceFeeBps = newBps;
    }

    /// @notice Add/remove a keeper (main + backup hot keys).
    function setKeeper(address keeper, bool allowed) external onlyOwner {
        if (keeper == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        _s().isKeeper[keeper] = allowed;
        emit KeeperSet(keeper, allowed);
    }

    /**
     * @notice Set the migoLP supply cap (PRD F1.2 — staged opening, oracle-free). `0` = uncapped.
     * @dev A non-zero cap must be >= the current `totalSupply()`: a cap below supply would brick every
     *      deposit until enough holders redeem, so it is rejected (`PoolmigoVault__InvalidSupplyCap`).
     *      To stop deposits outright, use {setRebalancePaused}. Redemptions are never affected.
     */
    function setMaxTotalSupply(uint256 newCap) external onlyOwner {
        uint256 supply = totalSupply();
        if (newCap != 0 && newCap < supply) {
            revert PoolmigoVault__InvalidSupplyCap(newCap, supply);
        }
        PoolmigoVaultStorage storage $ = _s();
        emit MaxTotalSupplySet($.maxTotalSupply, newCap);
        $.maxTotalSupply = newCap;
    }

    /// @notice Update the performance-fee treasury (multisig).
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        PoolmigoVaultStorage storage $ = _s();
        emit TreasurySet($.treasury, newTreasury);
        $.treasury = newTreasury;
    }

    /*//////////////////////////////////////////////////////////////
                     USER-FACING READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice Performance-fee recipient.
    function treasury() external view returns (address) {
        return _s().treasury;
    }

    /// @notice Performance fee in bps, charged in kind on harvested amounts only.
    function performanceFeeBps() external view returns (uint16) {
        return _s().performanceFeeBps;
    }

    /// @notice True while deposits / deploys / rebalances are paused (redemptions never pause).
    function rebalancePaused() external view returns (bool) {
        return _s().rebalancePaused;
    }

    /// @notice K — shares minted by the owner-gated genesis deposit (fixes the display scale, ≈$1/share).
    function genesisShares() external view returns (uint256) {
        return _s().genesisShares;
    }

    /// @notice migoLP supply cap; `0` = uncapped.
    function maxTotalSupply() external view returns (uint256) {
        return _s().maxTotalSupply;
    }

    /// @notice Whether `account` may call keeper functions.
    function isKeeper(address account) external view returns (bool) {
        return _s().isKeeper[account];
    }

    /// @notice Whether `account` is a registered position adapter.
    function isAdapter(address account) external view returns (bool) {
        return _s().isAdapter[account];
    }

    /// @notice Whether `token` is in the basket registry.
    function isToken(address token) external view returns (bool) {
        return _s().isToken[token];
    }

    /// @notice Basket registry (stable order; new tokens append).
    function tokens() external view returns (address[] memory) {
        return _s().tokens;
    }

    /// @notice Number of registered positions (across all DEXs/pools).
    function adapterCount() external view returns (uint256) {
        return _s().adapters.length;
    }

    /// @notice Registered position by index.
    function adapterAt(uint256 index) external view returns (IPositionAdapter) {
        return _s().adapters[index];
    }

    /// @notice All registered positions.
    function adapters() external view returns (IPositionAdapter[] memory) {
        return _s().adapters;
    }

    /**
     * @notice Total basket holdings: per registry token = idle balance + Σ over adapters of `position()`.
     * @dev Calls each adapter's `position()` once and scans in memory. Amounts an adapter reports for a
     *      token that is NOT registered are ignored (cannot be accounted); addAdapter prevents this.
     * @return tokens_ Registry tokens.
     * @return amounts Total amount held per token (idle + positions, incl. uncollected fees).
     */
    function totalTokens() public view returns (address[] memory tokens_, uint256[] memory amounts) {
        PoolmigoVaultStorage storage $ = _s();
        tokens_ = $.tokens;
        uint256 n = tokens_.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = IERC20(tokens_[i]).balanceOf(address(this));
        }
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = $.adapters[i].position();
            _accumulate(tokens_, amounts, t, a);
        }
    }

    /**
     * @notice Preview a deposit: shares minted and the exact amount pulled per offered token.
     * @dev Pure math per the {deposit} rules; reverts exactly as {deposit} would on bad input — including
     *      `PoolmigoVault__SupplyCapExceeded`, and `PoolmigoVault__GenesisNotOwner` at genesis (supply 0)
     *      unless called from the owner (e.g. an `eth_call` with `from = owner`).
     * @return shares Shares that would be minted.
     * @return requiredAmounts Amount that would be pulled per token, aligned to `tokens_`.
     */
    function previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        external
        view
        returns (uint256 shares, uint256[] memory requiredAmounts)
    {
        (shares, requiredAmounts) = _previewDeposit(tokens_, amounts_);
    }

    /**
     * @notice Preview a redemption: the EXACT amounts {redeem} would deliver in the current state.
     * @dev Mirrors {redeem}: per-adapter floor(sharesBps/10_000) slices + the vault's exact idle slice.
     *      Reads each adapter's `position()` for display only — {redeem} itself never depends on these
     *      reports, so a non-reporting adapter can never block redemptions.
     * @return tokens_ Registry tokens.
     * @return owedAmounts Amount delivered per token.
     */
    function previewRedeem(uint256 shares)
        external
        view
        returns (address[] memory tokens_, uint256[] memory owedAmounts)
    {
        tokens_ = _s().tokens;
        uint256 n = tokens_.length;
        owedAmounts = new uint256[](n);
        uint256 supply = totalSupply();
        if (supply == 0 || shares == 0) {
            return (tokens_, owedAmounts);
        }
        uint256 sharesBps = shares.mulDiv(BPS_DENOMINATOR, supply, Math.Rounding.Floor);
        uint256[] memory slices = _adapterSlices(tokens_, sharesBps);
        for (uint256 i; i < n; ++i) {
            owedAmounts[i] =
                slices[i] + shares.mulDiv(IERC20(tokens_[i]).balanceOf(address(this)), supply, Math.Rounding.Floor);
        }
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL STATE-CHANGING FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @notice UUPS upgrade authorization — owner only (multisig behind timelock on mainnet).
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @dev Shared registry insert for `initialize` and `addToken`.
    function _addToken(PoolmigoVaultStorage storage $, address token) private {
        if (token == address(0)) {
            revert PoolmigoVault__ZeroAddress();
        }
        if ($.isToken[token]) {
            revert PoolmigoVault__TokenAlreadyRegistered(token);
        }
        if ($.tokens.length >= MAX_TOKENS) {
            revert PoolmigoVault__MaxTokensReached(MAX_TOKENS);
        }
        $.isToken[token] = true;
        $.tokens.push(token);
        emit TokenAdded(token);
    }

    /*//////////////////////////////////////////////////////////////
                       INTERNAL READ-ONLY FUNCTIONS
    //////////////////////////////////////////////////////////////*/

    /// @dev Deposit math + input validation. See {deposit} for the rules.
    function _previewDeposit(address[] calldata tokens_, uint256[] calldata amounts_)
        internal
        view
        returns (uint256 shares, uint256[] memory required)
    {
        uint256 n = tokens_.length;
        if (n == 0 || n != amounts_.length) {
            revert PoolmigoVault__LengthMismatch();
        }

        (address[] memory registry, uint256[] memory totals) = totalTokens();
        uint256 m = registry.length;

        // Map registry index -> offered index (NOT_FOUND if not offered); rejects unknowns + duplicates.
        (uint256[] memory offeredAt, uint256[] memory registryIdx) = _mapOffered(registry, tokens_, n, m);

        uint256 supply = totalSupply();
        required = new uint256[](n);

        if (supply == 0) {
            // Genesis: owner only, strict full basket, every amount > 0, pulled in full; shares = K.
            // No virtuals here — K is the deliberate scale.
            if (msg.sender != owner()) {
                revert PoolmigoVault__GenesisNotOwner();
            }
            for (uint256 r; r < m; ++r) {
                if (offeredAt[r] == NOT_FOUND) {
                    revert PoolmigoVault__MissingBasketToken(registry[r]);
                }
            }
            for (uint256 i; i < n; ++i) {
                if (amounts_[i] == 0) {
                    revert PoolmigoVault__ZeroAmount();
                }
                required[i] = amounts_[i];
            }
            shares = _s().genesisShares;
        } else {
            // Normal: every held token must be offered; the binding (min-ratio) token sets the share count.
            shares = _bindingShares(registry, totals, offeredAt, amounts_, supply);
            if (shares == 0) {
                revert PoolmigoVault__ZeroShares();
            }
            // required_i = ceil(shares * (T_i + VA) / (S + VS)) <= amounts_[i] by construction;
            // tokens with T_i == 0 pull 0.
            _fillRequired(required, registryIdx, totals, shares, supply);
        }

        // Supply cap (PRD F1.2) — shared by {deposit} and {previewDeposit}, genesis included.
        uint256 cap = _s().maxTotalSupply;
        if (cap != 0 && supply + shares > cap) {
            revert PoolmigoVault__SupplyCapExceeded(supply + shares, cap);
        }
    }

    /// @dev Builds (registry index -> offered index) and (offered index -> registry index) maps.
    ///      Reverts on unknown or duplicate offered tokens.
    function _mapOffered(address[] memory registry, address[] calldata tokens_, uint256 n, uint256 m)
        private
        pure
        returns (uint256[] memory offeredAt, uint256[] memory registryIdx)
    {
        offeredAt = new uint256[](m);
        for (uint256 r; r < m; ++r) {
            offeredAt[r] = NOT_FOUND;
        }
        registryIdx = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 r = _indexOf(registry, tokens_[i]);
            if (r == NOT_FOUND) {
                revert PoolmigoVault__TokenNotRegistered(tokens_[i]);
            }
            if (offeredAt[r] != NOT_FOUND) {
                revert PoolmigoVault__DuplicateToken(tokens_[i]);
            }
            offeredAt[r] = i;
            registryIdx[i] = r;
        }
    }

    /// @dev Min-ratio share count over held tokens: min_i floor(amount_i * (S + VS) / (T_i + VA)).
    ///      Every held token (T_i > 0) must be offered with a nonzero amount.
    function _bindingShares(
        address[] memory registry,
        uint256[] memory totals,
        uint256[] memory offeredAt,
        uint256[] calldata amounts_,
        uint256 supply
    ) private pure returns (uint256 shares) {
        bool bound;
        uint256 m = registry.length;
        for (uint256 r; r < m; ++r) {
            if (totals[r] == 0) {
                continue;
            }
            uint256 i = offeredAt[r];
            if (i == NOT_FOUND) {
                revert PoolmigoVault__MissingBasketToken(registry[r]);
            }
            if (amounts_[i] == 0) {
                revert PoolmigoVault__ZeroAmount();
            }
            uint256 candidate =
                amounts_[i].mulDiv(supply + VIRTUAL_SHARES, totals[r] + VIRTUAL_ASSETS, Math.Rounding.Floor);
            if (!bound || candidate < shares) {
                shares = candidate;
                bound = true;
            }
        }
    }

    /// @dev required_i = ceil(shares * (T_i + VA) / (S + VS)); tokens with T_i == 0 pull nothing.
    function _fillRequired(
        uint256[] memory required,
        uint256[] memory registryIdx,
        uint256[] memory totals,
        uint256 shares,
        uint256 supply
    ) private pure {
        uint256 n = required.length;
        for (uint256 i; i < n; ++i) {
            uint256 total = totals[registryIdx[i]];
            if (total != 0) {
                required[i] = shares.mulDiv(total + VIRTUAL_ASSETS, supply + VIRTUAL_SHARES, Math.Rounding.Ceil);
            }
        }
    }

    /// @dev Per-token sum of floor(sharesBps * holding / 10_000) across adapters (registry-aligned).
    ///      Mirrors the bps flooring each adapter applies in {IPositionAdapter-withdrawProportional}.
    function _adapterSlices(address[] memory registry, uint256 sharesBps)
        private
        view
        returns (uint256[] memory slices)
    {
        uint256 n = registry.length;
        slices = new uint256[](n);
        if (sharesBps == 0) {
            return slices;
        }
        PoolmigoVaultStorage storage $ = _s();
        uint256 len = $.adapters.length;
        for (uint256 i; i < len; ++i) {
            (address[] memory t, uint256[] memory a) = $.adapters[i].position();
            uint256 m = t.length;
            for (uint256 j; j < m; ++j) {
                uint256 idx = _indexOf(registry, t[j]);
                if (idx != NOT_FOUND) {
                    slices[idx] += a[j].mulDiv(sharesBps, BPS_DENOMINATOR, Math.Rounding.Floor);
                }
            }
        }
    }

    /// @dev Add an adapter-reported (tokens, amounts) vector into registry-aligned `totals`.
    ///      Unregistered tokens are skipped (see {totalTokens}).
    function _accumulate(address[] memory registry, uint256[] memory totals, address[] memory t, uint256[] memory a)
        private
        pure
    {
        uint256 n = t.length;
        if (a.length != n) {
            revert PoolmigoVault__LengthMismatch();
        }
        for (uint256 i; i < n; ++i) {
            if (a[i] == 0) {
                continue;
            }
            uint256 idx = _indexOf(registry, t[i]);
            if (idx != NOT_FOUND) {
                totals[idx] += a[i];
            }
        }
    }

    /// @dev Linear scan (registry is <= MAX_TOKENS entries).
    function _indexOf(address[] memory registry, address token) private pure returns (uint256 idx) {
        uint256 n = registry.length;
        for (uint256 i; i < n; ++i) {
            if (registry[i] == token) {
                return i;
            }
        }
        return NOT_FOUND;
    }
}
