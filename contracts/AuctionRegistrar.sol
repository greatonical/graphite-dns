// SPDX-License-Identifier: MIT
pragma solidity ^0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IGraphiteDNSRegistry {
    function register(
        string calldata name,
        address owner,
        uint64 duration,
        address resolver,
        bytes32 parent
    ) external payable returns (bytes32);
    
    function isAvailable(bytes32 node) external view returns (bool);
    function TLD_NODE() external view returns (bytes32);
}

/**
 * @title AuctionRegistrar
 * @dev Enhanced auction system with anti-sniping and proper fund handling
 */
contract AuctionRegistrar is 
    AccessControl, 
    Pausable, 
    ReentrancyGuard,
    UUPSUpgradeable 
{
    using ECDSA for bytes32;

    IGraphiteDNSRegistry public immutable registry;
    bytes32 public immutable TLD_NODE;
    
    bytes32 public constant AUCTIONEER_ROLE = keccak256("AUCTIONEER_ROLE");
    
    // Anti-sniping settings
    uint256 public constant EXTENSION_WINDOW = 10 minutes;
    uint256 public constant EXTENSION_DURATION = 10 minutes;
    uint256 public constant MIN_BID_INCREMENT = 0.01 ether;
    uint256 public constant MIN_COMMIT_DURATION = 1 hours;
    uint256 public constant MIN_REVEAL_DURATION = 1 hours;
    uint256 public constant MAX_AUCTION_DURATION = 7 days;
    
    enum AuctionState {
        None,
        Commit,
        Reveal,
        Ended,
        Finalized
    }
    
    struct Auction {
        string name;
        uint256 commitStart;
        uint256 commitEnd;
        uint256 revealEnd;
        uint256 minBid;
        address highestBidder;
        uint256 highestBid;
        uint256 secondHighestBid;
        AuctionState state;
        mapping(address => bytes32) commitments;
        mapping(address => uint256) deposits;
        mapping(address => bool) revealed;
        address[] bidders;
        uint256 totalDeposits;
        bool fundsWithdrawn;
    }
    
    mapping(bytes32 => Auction) private _auctions;
    mapping(address => uint256) private _pendingWithdrawals;
    
    // Events with comprehensive data for indexing
    event AuctionStarted(
        bytes32 indexed node,
        string name,
        uint256 commitStart,
        uint256 commitEnd,
        uint256 revealEnd,
        uint256 minBid
    );
    
    event BidCommitted(
        bytes32 indexed node,
        address indexed bidder,
        bytes32 commitment,
        uint256 deposit,
        uint256 timestamp
    );
    
    event BidRevealed(
        bytes32 indexed node,
        address indexed bidder,
        uint256 bid,
        uint256 deposit,
        bool isValid,
        uint256 timestamp
    );
    
    event NewHighestBid(
        bytes32 indexed node,
        address indexed bidder,
        uint256 bid,
        uint256 previousBid,
        address previousBidder
    );
    
    event AuctionExtended(
        bytes32 indexed node,
        uint256 newRevealEnd,
        address triggeringBidder
    );
    
    event AuctionFinalized(
        bytes32 indexed node,
        address indexed winner,
        uint256 winningBid,
        uint256 totalRefunded
    );
    
    event AuctionCancelled(
        bytes32 indexed node,
        string reason,
        uint256 totalRefunded
    );
    
    event WithdrawalProcessed(
        address indexed account,
        uint256 amount
    );

    constructor(address _registry) {
        registry = IGraphiteDNSRegistry(_registry);
        TLD_NODE = registry.TLD_NODE();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(AUCTIONEER_ROLE, msg.sender);
    }

    modifier validAuctionParams(
        uint256 commitDuration,
        uint256 revealDuration,
        uint256 minBid
    ) {
        require(commitDuration >= MIN_COMMIT_DURATION, "Commit duration too short");
        require(revealDuration >= MIN_REVEAL_DURATION, "Reveal duration too short");
        require(commitDuration + revealDuration <= MAX_AUCTION_DURATION, "Total duration too long");
        require(minBid > 0, "Minimum bid must be positive");
        _;
    }

    modifier onlyValidName(string memory name) {
        require(bytes(name).length > 0, "Empty name");
        require(bytes(name).length <= 63, "Name too long");
        _;
    }

    // Start auction
    function startAuction(
        string calldata name,
        uint256 commitDuration,
        uint256 revealDuration,
        uint256 minBid
    )
        external
        onlyRole(AUCTIONEER_ROLE)
        whenNotPaused
        nonReentrant
        onlyValidName(name)
        validAuctionParams(commitDuration, revealDuration, minBid)
    {
        bytes32 node = _makeNode(name);
        require(registry.isAvailable(node), "Name not available");
        require(_auctions[node].state == AuctionState.None, "Auction already exists");

        Auction storage auction = _auctions[node];
        auction.name = name;
        auction.commitStart = block.timestamp;
        auction.commitEnd = block.timestamp + commitDuration;
        auction.revealEnd = auction.commitEnd + revealDuration;
        auction.minBid = minBid;
        auction.state = AuctionState.Commit;

        emit AuctionStarted(
            node,
            name,
            auction.commitStart,
            auction.commitEnd,
            auction.revealEnd,
            minBid
        );
    }

    // Commit bid
    function commitBid(string calldata name, bytes32 commitment)
        external
        payable
        whenNotPaused
        nonReentrant
        onlyValidName(name)
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        require(auction.state == AuctionState.Commit, "Not in commit phase");
        require(block.timestamp >= auction.commitStart, "Commit phase not started");
        require(block.timestamp <= auction.commitEnd, "Commit phase ended");
        require(auction.commitments[msg.sender] == bytes32(0), "Already committed");
        require(msg.value >= auction.minBid, "Deposit below minimum bid");
        require(commitment != bytes32(0), "Invalid commitment");

        auction.commitments[msg.sender] = commitment;
        auction.deposits[msg.sender] = msg.value;
        auction.bidders.push(msg.sender);
        auction.totalDeposits += msg.value;

        emit BidCommitted(node, msg.sender, commitment, msg.value, block.timestamp);
    }

    // Reveal bid with anti-sniping
    function revealBid(
        string calldata name,
        uint256 bid,
        bytes32 salt
    )
        external
        whenNotPaused
        nonReentrant
        onlyValidName(name)
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        require(auction.state == AuctionState.Commit || auction.state == AuctionState.Reveal, "Wrong phase");
        require(block.timestamp >= auction.commitEnd, "Reveal phase not started");
        require(block.timestamp <= auction.revealEnd, "Reveal phase ended");
        require(!auction.revealed[msg.sender], "Already revealed");
        require(auction.commitments[msg.sender] != bytes32(0), "No commitment found");

        // Transition to reveal state if first reveal
        if (auction.state == AuctionState.Commit) {
            auction.state = AuctionState.Reveal;
        }

        // Verify commitment
        bytes32 expectedCommitment = keccak256(abi.encodePacked(bid, salt, msg.sender));
        bool isValidBid = (expectedCommitment == auction.commitments[msg.sender]) &&
                         (bid >= auction.minBid) &&
                         (auction.deposits[msg.sender] >= bid);

        auction.revealed[msg.sender] = true;

        emit BidRevealed(node, msg.sender, bid, auction.deposits[msg.sender], isValidBid, block.timestamp);

        if (isValidBid && bid > auction.highestBid) {
            // Check for anti-sniping extension
            if (block.timestamp > auction.revealEnd - EXTENSION_WINDOW) {
                auction.revealEnd += EXTENSION_DURATION;
                emit AuctionExtended(node, auction.revealEnd, msg.sender);
            }

            address previousBidder = auction.highestBidder;
            uint256 previousBid = auction.highestBid;

            auction.secondHighestBid = auction.highestBid;
            auction.highestBid = bid;
            auction.highestBidder = msg.sender;

            emit NewHighestBid(node, msg.sender, bid, previousBid, previousBidder);
        } else if (!isValidBid) {
            // Invalid bid - add to pending withdrawals
            _pendingWithdrawals[msg.sender] += auction.deposits[msg.sender];
        }
    }

    // Finalize auction
    function finalizeAuction(
        string calldata name,
        uint64 duration,
        address resolver
    )
        external
        whenNotPaused
        nonReentrant
        onlyValidName(name)
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        require(auction.state == AuctionState.Reveal, "Not in reveal phase");
        require(block.timestamp > auction.revealEnd, "Reveal phase not ended");
        require(!auction.fundsWithdrawn, "Already finalized");

        auction.state = AuctionState.Ended;
        auction.fundsWithdrawn = true;

        if (auction.highestBidder == address(0)) {
            // No valid bids - refund all deposits
            auction.state = AuctionState.Finalized;
            _refundAllBidders(node);
            emit AuctionCancelled(node, "No valid bids", auction.totalDeposits);
            return;
        }

        // Calculate payment (Vickrey auction - pay second highest bid)
        uint256 paymentAmount = auction.secondHighestBid > 0 ? 
                               auction.secondHighestBid : 
                               auction.highestBid;

        // Register domain to winner
        try registry.register{value: paymentAmount}(
            name,
            auction.highestBidder,
            duration,
            resolver,
            TLD_NODE
        ) {
            auction.state = AuctionState.Finalized;
            
            // Process refunds
            uint256 totalRefunded = _processRefunds(node, paymentAmount);
            
            emit AuctionFinalized(node, auction.highestBidder, paymentAmount, totalRefunded);
        } catch {
            // Registration failed - refund all and cancel
            auction.state = AuctionState.Finalized;
            auction.fundsWithdrawn = false;
            _refundAllBidders(node);
            emit AuctionCancelled(node, "Registration failed", auction.totalDeposits);
        }
    }

    // Cancel auction (admin only)
    function cancelAuction(string calldata name, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        whenNotPaused
        nonReentrant
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        require(auction.state != AuctionState.None, "Auction does not exist");
        require(auction.state != AuctionState.Finalized, "Already finalized");

        auction.state = AuctionState.Finalized;
        uint256 totalRefunded = _refundAllBidders(node);
        
        emit AuctionCancelled(node, reason, totalRefunded);
    }

    // Withdraw pending funds
    function withdraw() external nonReentrant {
        uint256 amount = _pendingWithdrawals[msg.sender];
        require(amount > 0, "No funds to withdraw");
        
        _pendingWithdrawals[msg.sender] = 0;
        
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Withdrawal failed");
        
        emit WithdrawalProcessed(msg.sender, amount);
    }

    // Emergency withdrawal for specific user (admin only)
    function emergencyWithdraw(address user) 
        external 
        onlyRole(DEFAULT_ADMIN_ROLE) 
        nonReentrant 
    {
        uint256 amount = _pendingWithdrawals[user];
        require(amount > 0, "No funds to withdraw");
        
        _pendingWithdrawals[user] = 0;
        
        (bool success, ) = payable(user).call{value: amount}("");
        require(success, "Emergency withdrawal failed");
        
        emit WithdrawalProcessed(user, amount);
    }

    // Internal functions
    function _makeNode(string memory name) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(TLD_NODE, keccak256(bytes(name))));
    }

    function _processRefunds(bytes32 node, uint256 paymentAmount) internal returns (uint256 totalRefunded) {
        Auction storage auction = _auctions[node];
        
        for (uint256 i = 0; i < auction.bidders.length; i++) {
            address bidder = auction.bidders[i];
            uint256 deposit = auction.deposits[bidder];
            
            if (bidder == auction.highestBidder) {
                // Winner pays second highest bid, gets difference refunded
                uint256 refund = deposit - paymentAmount;
                if (refund > 0) {
                    _pendingWithdrawals[bidder] += refund;
                    totalRefunded += refund;
                }
            } else {
                // All other bidders get full refund
                _pendingWithdrawals[bidder] += deposit;
                totalRefunded += deposit;
            }
        }
    }

    function _refundAllBidders(bytes32 node) internal returns (uint256 totalRefunded) {
        Auction storage auction = _auctions[node];
        
        for (uint256 i = 0; i < auction.bidders.length; i++) {
            address bidder = auction.bidders[i];
            uint256 deposit = auction.deposits[bidder];
            
            _pendingWithdrawals[bidder] += deposit;
            totalRefunded += deposit;
        }
    }

    // View functions
    function getAuction(string calldata name) 
        external 
        view 
        returns (
            AuctionState state,
            uint256 commitStart,
            uint256 commitEnd,
            uint256 revealEnd,
            uint256 minBid,
            address highestBidder,
            uint256 highestBid,
            uint256 secondHighestBid,
            uint256 totalDeposits,
            uint256 bidderCount
        ) 
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        return (
            auction.state,
            auction.commitStart,
            auction.commitEnd,
            auction.revealEnd,
            auction.minBid,
            auction.highestBidder,
            auction.highestBid,
            auction.secondHighestBid,
            auction.totalDeposits,
            auction.bidders.length
        );
    }

    function getBidderInfo(string calldata name, address bidder)
        external
        view
        returns (
            bytes32 commitment,
            uint256 deposit,
            bool revealed
        )
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        return (
            auction.commitments[bidder],
            auction.deposits[bidder],
            auction.revealed[bidder]
        );
    }

    function getAllBidders(string calldata name) 
        external 
        view 
        returns (address[] memory) 
    {
        bytes32 node = _makeNode(name);
        return _auctions[node].bidders;
    }

    function pendingWithdrawal(address account) external view returns (uint256) {
        return _pendingWithdrawals[account];
    }

    function generateCommitment(
        uint256 bid,
        bytes32 salt,
        address bidder
    ) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(bid, salt, bidder));
    }

    function isValidCommitment(
        string calldata name,
        address bidder,
        uint256 bid,
        bytes32 salt
    ) external view returns (bool) {
        bytes32 node = _makeNode(name);
        bytes32 stored = _auctions[node].commitments[bidder];
        bytes32 expected = keccak256(abi.encodePacked(bid, salt, bidder));
        return stored == expected && stored != bytes32(0);
    }

    function getCurrentPhase(string calldata name) 
        external 
        view 
        returns (AuctionState phase, uint256 timeRemaining) 
    {
        bytes32 node = _makeNode(name);
        Auction storage auction = _auctions[node];
        
        if (auction.state == AuctionState.None) {
            return (AuctionState.None, 0);
        }
        
        if (auction.state == AuctionState.Finalized) {
            return (AuctionState.Finalized, 0);
        }
        
        if (block.timestamp <= auction.commitEnd) {
            return (AuctionState.Commit, auction.commitEnd - block.timestamp);
        } else if (block.timestamp <= auction.revealEnd) {
            return (AuctionState.Reveal, auction.revealEnd - block.timestamp);
        } else {
            return (AuctionState.Ended, 0);
        }
    }

    function getAuctionStats() 
        external 
        view 
        returns (
            uint256 totalAuctions,
            uint256 activeAuctions,
            uint256 totalValueLocked
        ) 
    {
        // Note: This would require additional tracking in a production system
        // For now, returning placeholder values
        return (0, 0, address(this).balance);
    }

    // Admin functions
    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function withdrawTreasury() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds to withdraw");
        
        (bool success, ) = payable(msg.sender).call{value: balance}("");
        require(success, "Treasury withdrawal failed");
    }

    function _authorizeUpgrade(address newImplementation) 
        internal 
        override 
        onlyRole(DEFAULT_ADMIN_ROLE) 
    {}

    function supportsInterface(bytes4 interfaceId) 
        public 
        view 
        override(AccessControl) 
        returns (bool) 
    {
        return super.supportsInterface(interfaceId);
    }

    // Fallback for direct payments (will be added to pending withdrawals)
    receive() external payable {
        _pendingWithdrawals[msg.sender] += msg.value;
    }
}