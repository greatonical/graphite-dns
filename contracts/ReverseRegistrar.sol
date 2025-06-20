// contracts/ReverseRegistrar.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";

contract ReverseRegistrar is AccessControl {
    bytes32 public constant REVERSE_ROLE = keccak256("REVERSE_ROLE");
    mapping(address => string) private _names;

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REVERSE_ROLE, msg.sender);
    }

    function setReverse(string calldata name) external onlyRole(REVERSE_ROLE) {
        _names[msg.sender] = name;
    }

    function getReverse(address who) external view returns (string memory) {
        return _names[who];
    }
}
