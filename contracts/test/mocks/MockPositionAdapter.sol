// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IPositionAdapter} from "contracts/interfaces/IPositionAdapter.sol";
import {MockToken} from "test/mocks/MockToken.sol";

/**
 * @notice Test double for a multi-token position adapter on a specific DEX/pool. Holds the basket tokens
 *         as a stand-in "position" with deterministic bookkeeping: `deployed` principal per token plus a
 *         `harvestable` fee bucket per token (both actually held by this contract). Lets tests inject
 *         fees, and honours proportional withdrawals in kind.
 *         Not for production — a real adapter wraps Uniswap V3/V4.
 */
contract MockPositionAdapter is IPositionAdapter {
    using SafeERC20 for IERC20;

    address public immutable vault;
    bytes32 private immutable _dex;
    bytes32 private immutable _poolId;

    address[] private _tokens;
    /// @dev Principal deployed per token (aligned to `_tokens`).
    uint256[] private _deployed;
    /// @dev Fees accrued but not yet harvested per token (aligned to `_tokens`); tokens are held here.
    uint256[] private _harvestable;
    /// @dev Test probe: allowance the vault had granted this adapter at the moment of the last `deploy`.
    uint256[] public allowanceSeenOnDeploy;

    error MockAdapter__OnlyVault();
    error MockAdapter__LengthMismatch();

    modifier onlyVault() {
        if (msg.sender != vault) revert MockAdapter__OnlyVault();
        _;
    }

    constructor(address[] memory tokens_, address vault_, bytes32 dex_, bytes32 poolId_) {
        _tokens = tokens_;
        vault = vault_;
        _dex = dex_;
        _poolId = poolId_;
        _deployed = new uint256[](tokens_.length);
        _harvestable = new uint256[](tokens_.length);
        allowanceSeenOnDeploy = new uint256[](tokens_.length);
    }

    /*//////////////////////////////////////////////////////////////
                              TEST HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pretend the position accrued `amounts[i]` of fees in token i: mints them here + marks harvestable.
    function simulateFees(uint256[] calldata amounts) external {
        uint256 n = _tokens.length;
        if (amounts.length != n) revert MockAdapter__LengthMismatch();
        for (uint256 i; i < n; ++i) {
            if (amounts[i] != 0) {
                MockToken(_tokens[i]).mint(address(this), amounts[i]);
                _harvestable[i] += amounts[i];
            }
        }
    }

    /// @notice Anyone pays `amounts[i]` of token i INTO the position (real transferFrom, no mint) — models an
    ///         adapter-side donation (e.g. fees an attacker pays into the pool). Counted as harvestable.
    function donate(uint256[] calldata amounts) external {
        uint256 n = _tokens.length;
        if (amounts.length != n) revert MockAdapter__LengthMismatch();
        for (uint256 i; i < n; ++i) {
            if (amounts[i] != 0) {
                IERC20(_tokens[i]).safeTransferFrom(msg.sender, address(this), amounts[i]);
                _harvestable[i] += amounts[i];
            }
        }
    }

    function deployed(uint256 i) external view returns (uint256) {
        return _deployed[i];
    }

    function harvestable(uint256 i) external view returns (uint256) {
        return _harvestable[i];
    }

    /*//////////////////////////////////////////////////////////////
                            IPositionAdapter
    //////////////////////////////////////////////////////////////*/

    function dex() external view returns (bytes32) {
        return _dex;
    }

    function poolId() external view returns (bytes32) {
        return _poolId;
    }

    function position() public view returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        uint256 n = tokens.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            amounts[i] = _deployed[i] + _harvestable[i];
        }
    }

    function deploy(uint256[] calldata amounts)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory deployedNow)
    {
        tokens = _tokens;
        uint256 n = tokens.length;
        if (amounts.length != n) revert MockAdapter__LengthMismatch();
        deployedNow = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            allowanceSeenOnDeploy[i] = IERC20(tokens[i]).allowance(vault, address(this));
            if (amounts[i] != 0) {
                IERC20(tokens[i]).safeTransferFrom(vault, address(this), amounts[i]);
                _deployed[i] += amounts[i];
                deployedNow[i] = amounts[i];
            }
        }
    }

    function withdrawProportional(uint256 sharesBps, address to)
        external
        onlyVault
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        tokens = _tokens;
        uint256 n = tokens.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 out = ((_deployed[i] + _harvestable[i]) * sharesBps) / 10_000;
            if (out == 0) continue;
            // Draw from principal first, then from the fee bucket.
            uint256 fromDeployed = out < _deployed[i] ? out : _deployed[i];
            _deployed[i] -= fromDeployed;
            _harvestable[i] -= out - fromDeployed;
            IERC20(tokens[i]).safeTransfer(to, out);
            amounts[i] = out;
        }
    }

    function harvest() external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        uint256 n = tokens.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            uint256 out = _harvestable[i];
            if (out == 0) continue;
            _harvestable[i] = 0;
            IERC20(tokens[i]).safeTransfer(vault, out);
            amounts[i] = out;
        }
    }

    function unwindAll(address to) external onlyVault returns (address[] memory tokens, uint256[] memory amounts) {
        tokens = _tokens;
        uint256 n = tokens.length;
        amounts = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            _deployed[i] = 0;
            _harvestable[i] = 0;
            uint256 out = IERC20(tokens[i]).balanceOf(address(this));
            if (out == 0) continue;
            IERC20(tokens[i]).safeTransfer(to, out);
            amounts[i] = out;
        }
    }
}
