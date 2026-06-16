// Advanced contract templates for LANAgent

export const templates = {
    // Enhanced ERC-20 with features
    'erc20-advanced': {
        name: 'Advanced ERC-20 Token',
        description: 'ERC-20 with minting, burning, pausing, and governance',
        code: (contractName, params = {}) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Snapshot.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";

contract ${contractName} is ERC20, ERC20Burnable, ERC20Snapshot, AccessControl, Pausable, ERC20Permit, ERC20Votes {
    bytes32 public constant SNAPSHOT_ROLE = keccak256("SNAPSHOT_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint256 private _cap;

    constructor(
        string memory name,
        string memory symbol,
        uint256 initialSupply,
        uint256 cap_
    ) ERC20(name, symbol) ERC20Permit(name) {
        _cap = cap_ * 10 ** decimals();
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SNAPSHOT_ROLE, msg.sender);
        _grantRole(PAUSER_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
        _mint(msg.sender, initialSupply * 10 ** decimals());
    }

    function cap() public view returns (uint256) {
        return _cap;
    }

    function snapshot() public onlyRole(SNAPSHOT_ROLE) {
        _snapshot();
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        require(totalSupply() + amount <= cap(), "Cap exceeded");
        _mint(to, amount);
    }

    function _beforeTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Snapshot) whenNotPaused {
        super._beforeTokenTransfer(from, to, amount);
    }

    // Required overrides
    function _afterTokenTransfer(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Votes) {
        super._afterTokenTransfer(from, to, amount);
    }

    function _mint(address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._mint(to, amount);
    }

    function _burn(address account, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._burn(account, amount);
    }
}`
    },

    // Staking contract
    'staking': {
        name: 'Token Staking Contract',
        description: 'Stake tokens to earn rewards',
        code: (contractName) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ${contractName} is ReentrancyGuard, Ownable {
    IERC20 public stakingToken;
    IERC20 public rewardsToken;
    
    uint256 public rewardRate = 100; // Rewards per second
    uint256 public lastUpdateTime;
    uint256 public rewardPerTokenStored;
    
    mapping(address => uint256) public userRewardPerTokenPaid;
    mapping(address => uint256) public rewards;
    mapping(address => uint256) public balances;
    
    uint256 private _totalSupply;
    
    event Staked(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event RewardPaid(address indexed user, uint256 reward);
    
    constructor(address _stakingToken, address _rewardsToken) Ownable(msg.sender) {
        stakingToken = IERC20(_stakingToken);
        rewardsToken = IERC20(_rewardsToken);
    }
    
    function totalSupply() external view returns (uint256) {
        return _totalSupply;
    }
    
    function balanceOf(address account) external view returns (uint256) {
        return balances[account];
    }
    
    function rewardPerToken() public view returns (uint256) {
        if (_totalSupply == 0) {
            return rewardPerTokenStored;
        }
        return
            rewardPerTokenStored +
            ((block.timestamp - lastUpdateTime) * rewardRate * 1e18) / _totalSupply;
    }
    
    function earned(address account) public view returns (uint256) {
        return
            (balances[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / 1e18 +
            rewards[account];
    }
    
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }
    
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot stake 0");
        _totalSupply += amount;
        balances[msg.sender] += amount;
        stakingToken.transferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }
    
    function withdraw(uint256 amount) external nonReentrant updateReward(msg.sender) {
        require(amount > 0, "Cannot withdraw 0");
        _totalSupply -= amount;
        balances[msg.sender] -= amount;
        stakingToken.transfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
    
    function getReward() external nonReentrant updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            rewardsToken.transfer(msg.sender, reward);
            emit RewardPaid(msg.sender, reward);
        }
    }
    
    function setRewardRate(uint256 _rewardRate) external onlyOwner {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = block.timestamp;
        rewardRate = _rewardRate;
    }
}`
    },

    // NFT Marketplace
    'nft-marketplace': {
        name: 'NFT Marketplace',
        description: 'Buy and sell NFTs with royalties',
        code: (contractName) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract ${contractName} is ReentrancyGuard, Ownable {
    struct Listing {
        address seller;
        address nftContract;
        uint256 tokenId;
        uint256 price;
        bool active;
    }
    
    uint256 public listingIdCounter;
    uint256 public marketplaceFee = 250; // 2.5%
    
    mapping(uint256 => Listing) public listings;
    mapping(address => mapping(uint256 => uint256)) public nftToListingId;
    
    event Listed(uint256 indexed listingId, address indexed seller, address indexed nftContract, uint256 tokenId, uint256 price);
    event Sale(uint256 indexed listingId, address indexed buyer, uint256 price);
    event ListingCancelled(uint256 indexed listingId);
    
    constructor() Ownable(msg.sender) {}
    
    function list(address nftContract, uint256 tokenId, uint256 price) external nonReentrant {
        require(price > 0, "Price must be greater than 0");
        require(IERC721(nftContract).ownerOf(tokenId) == msg.sender, "Not the owner");
        require(IERC721(nftContract).getApproved(tokenId) == address(this) || 
                IERC721(nftContract).isApprovedForAll(msg.sender, address(this)), 
                "Marketplace not approved");
        
        uint256 listingId = listingIdCounter++;
        listings[listingId] = Listing({
            seller: msg.sender,
            nftContract: nftContract,
            tokenId: tokenId,
            price: price,
            active: true
        });
        
        nftToListingId[nftContract][tokenId] = listingId;
        
        emit Listed(listingId, msg.sender, nftContract, tokenId, price);
    }
    
    function buy(uint256 listingId) external payable nonReentrant {
        Listing storage listing = listings[listingId];
        require(listing.active, "Listing not active");
        require(msg.value >= listing.price, "Insufficient payment");
        
        listing.active = false;
        
        // Calculate fees
        uint256 fee = (listing.price * marketplaceFee) / 10000;
        uint256 sellerProceeds = listing.price - fee;
        
        // Transfer NFT to buyer
        IERC721(listing.nftContract).safeTransferFrom(listing.seller, msg.sender, listing.tokenId);
        
        // Transfer funds
        payable(listing.seller).transfer(sellerProceeds);
        payable(owner()).transfer(fee);
        
        // Refund excess payment
        if (msg.value > listing.price) {
            payable(msg.sender).transfer(msg.value - listing.price);
        }
        
        emit Sale(listingId, msg.sender, listing.price);
    }
    
    function cancelListing(uint256 listingId) external {
        Listing storage listing = listings[listingId];
        require(listing.seller == msg.sender, "Not the seller");
        require(listing.active, "Listing not active");
        
        listing.active = false;
        delete nftToListingId[listing.nftContract][listing.tokenId];
        
        emit ListingCancelled(listingId);
    }
    
    function setMarketplaceFee(uint256 _fee) external onlyOwner {
        require(_fee <= 1000, "Fee too high"); // Max 10%
        marketplaceFee = _fee;
    }
}`
    },

    // Revenue Sharing
    'revenue-sharing': {
        name: 'Revenue Sharing Contract',
        description: 'Automatically distribute revenue to multiple parties',
        code: (contractName) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract ${contractName} is ReentrancyGuard {
    struct Recipient {
        address account;
        uint256 shares;
    }
    
    Recipient[] public recipients;
    uint256 public totalShares;
    
    mapping(address => uint256) public pendingPayments;
    
    event PaymentReceived(address from, uint256 amount);
    event PaymentReleased(address to, uint256 amount);
    event RecipientAdded(address account, uint256 shares);
    event RecipientRemoved(address account);
    
    constructor(address[] memory _recipients, uint256[] memory _shares) {
        require(_recipients.length == _shares.length, "Length mismatch");
        require(_recipients.length > 0, "No recipients");
        
        for (uint256 i = 0; i < _recipients.length; i++) {
            _addRecipient(_recipients[i], _shares[i]);
        }
    }
    
    receive() external payable {
        emit PaymentReceived(msg.sender, msg.value);
        _distribute(msg.value);
    }
    
    function _distribute(uint256 amount) private {
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 payment = (amount * recipients[i].shares) / totalShares;
            pendingPayments[recipients[i].account] += payment;
        }
    }
    
    function release() external nonReentrant {
        uint256 payment = pendingPayments[msg.sender];
        require(payment > 0, "No payment pending");
        
        pendingPayments[msg.sender] = 0;
        payable(msg.sender).transfer(payment);
        
        emit PaymentReleased(msg.sender, payment);
    }
    
    function releaseToken(IERC20 token) external nonReentrant {
        uint256 totalBalance = token.balanceOf(address(this));
        require(totalBalance > 0, "No tokens to release");
        
        for (uint256 i = 0; i < recipients.length; i++) {
            uint256 payment = (totalBalance * recipients[i].shares) / totalShares;
            token.transfer(recipients[i].account, payment);
        }
    }
    
    function _addRecipient(address account, uint256 shares) private {
        require(account != address(0), "Zero address");
        require(shares > 0, "Shares must be > 0");
        
        recipients.push(Recipient({account: account, shares: shares}));
        totalShares += shares;
        
        emit RecipientAdded(account, shares);
    }
    
    function getRecipientCount() external view returns (uint256) {
        return recipients.length;
    }
}`
    },

    // Time-locked Vault
    'timelock-vault': {
        name: 'Time-locked Vault',
        description: 'Lock tokens/ETH for a specified period',
        code: (contractName) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

contract ${contractName} is ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    struct Lock {
        address beneficiary;
        uint256 amount;
        uint256 releaseTime;
        bool withdrawn;
        address token; // address(0) for ETH
    }
    
    uint256 public lockIdCounter;
    mapping(uint256 => Lock) public locks;
    mapping(address => uint256[]) public userLocks;
    
    event Locked(uint256 indexed lockId, address indexed beneficiary, uint256 amount, uint256 releaseTime, address token);
    event Released(uint256 indexed lockId, address indexed beneficiary, uint256 amount);
    
    function lockETH(address beneficiary, uint256 releaseTime) external payable nonReentrant {
        require(msg.value > 0, "No ETH sent");
        require(releaseTime > block.timestamp, "Release time must be in future");
        require(beneficiary != address(0), "Invalid beneficiary");
        
        uint256 lockId = lockIdCounter++;
        locks[lockId] = Lock({
            beneficiary: beneficiary,
            amount: msg.value,
            releaseTime: releaseTime,
            withdrawn: false,
            token: address(0)
        });
        
        userLocks[beneficiary].push(lockId);
        
        emit Locked(lockId, beneficiary, msg.value, releaseTime, address(0));
    }
    
    function lockTokens(
        address token,
        address beneficiary,
        uint256 amount,
        uint256 releaseTime
    ) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(releaseTime > block.timestamp, "Release time must be in future");
        require(beneficiary != address(0), "Invalid beneficiary");
        
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        
        uint256 lockId = lockIdCounter++;
        locks[lockId] = Lock({
            beneficiary: beneficiary,
            amount: amount,
            releaseTime: releaseTime,
            withdrawn: false,
            token: token
        });
        
        userLocks[beneficiary].push(lockId);
        
        emit Locked(lockId, beneficiary, amount, releaseTime, token);
    }
    
    function release(uint256 lockId) external nonReentrant {
        Lock storage lock = locks[lockId];
        require(lock.beneficiary == msg.sender, "Not beneficiary");
        require(block.timestamp >= lock.releaseTime, "Still locked");
        require(!lock.withdrawn, "Already withdrawn");
        
        lock.withdrawn = true;
        
        if (lock.token == address(0)) {
            payable(msg.sender).transfer(lock.amount);
        } else {
            IERC20(lock.token).safeTransfer(msg.sender, lock.amount);
        }
        
        emit Released(lockId, msg.sender, lock.amount);
    }
    
    function getUserLockCount(address user) external view returns (uint256) {
        return userLocks[user].length;
    }
    
    function getTimeUntilRelease(uint256 lockId) external view returns (uint256) {
        if (block.timestamp >= locks[lockId].releaseTime) {
            return 0;
        }
        return locks[lockId].releaseTime - block.timestamp;
    }
}`
    }
};

// Template categories for organization
export const templateCategories = {
    tokens: ['erc20-advanced'],
    defi: ['staking', 'revenue-sharing', 'timelock-vault'],
    nft: ['nft-marketplace'],
    utility: ['revenue-sharing', 'timelock-vault']
};

// Get template by ID
export function getTemplate(templateId) {
    return templates[templateId];
}

// Get all templates
export function getAllTemplates() {
    return Object.keys(templates).map(id => ({
        id,
        ...templates[id]
    }));
}

// Get templates by category
export function getTemplatesByCategory(category) {
    const templateIds = templateCategories[category] || [];
    return templateIds.map(id => ({
        id,
        ...templates[id]
    }));
}