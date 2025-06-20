// contracts/GraphiteResolver.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract GraphiteResolver is AccessControl {
    bytes32 public constant RESOLVER_ROLE = keccak256("RESOLVER_ROLE");
    mapping(bytes32 => mapping(string => string)) private _records;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(RESOLVER_ROLE, msg.sender);
    }

    function setText(bytes32 node, string calldata key, string calldata value)
        external onlyRole(RESOLVER_ROLE)
    {
        _records[node][key] = value;
    }

    function text(bytes32 node, string calldata key) external view returns (string memory) {
        return _records[node][key];
    }
}
