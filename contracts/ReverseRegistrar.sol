// contracts/ReverseRegistrar.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

contract ReverseRegistrar is AccessControl, Pausable {
    bytes32 public constant REVERSE_ROLE = keccak256("REVERSE_ROLE");

    // wallet → reverse name
    mapping(address => string) private _names;

    event ReverseSet(address indexed who, string name);

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(REVERSE_ROLE, msg.sender);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }
    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setReverse(string calldata name)
        external
        onlyRole(REVERSE_ROLE)
        whenNotPaused
    {
        _names[msg.sender] = name;
        emit ReverseSet(msg.sender, name);
    }

    function getReverse(address who)
        external
        view
        returns (string memory)
    {
        return _names[who];
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
