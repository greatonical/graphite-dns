// contracts/GraphiteResolver.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract GraphiteResolver is AccessControl, Pausable {
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");

    // node → (key → value)
    mapping(bytes32 => mapping(string => string)) private _textRecords;

    event TextChanged(bytes32 indexed node, string key, string value);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setText(
        bytes32 node,
        string calldata key,
        string calldata value
    )
        external
        onlyRole(RESOLVER_ROLE)
        whenNotPaused
    {
        _textRecords[node][key] = value;
        emit TextChanged(node, key, value);
    }

    function text(bytes32 node, string calldata key)
        external
        view
        returns (string memory)
    {
        return _textRecords[node][key];
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
