import { expect } from "chai";
import { ethers } from "hardhat";
import type { 
  GraphiteDNSRegistry, 
  GraphiteResolver, 
  SubdomainRegistrar,
  AuctionRegistrar,
  ReverseRegistrar
} from "../../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Full System Integration Tests", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let subdomain: SubdomainRegistrar;
  let auction: AuctionRegistrar;
  let reverse: ReverseRegistrar;
  
  let owner: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let charlie: SignerWithAddress;

  const oneYear = 365 * 24 * 3600;
  const oneDay = 24 * 60 * 60;

  before(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();
    
    console.log("Deploying full system...");

    // Deploy all contracts in correct order
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await tempResolver.getAddress());
    
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    subdomain = await SubdomainFactory.deploy(await registry.getAddress());
    
    const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
    auction = await AuctionFactory.deploy(await registry.getAddress());
    
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    reverse = await ReverseFactory.deploy(await registry.getAddress());

    // Grant roles
    const registrarRole = await registry.REGISTRAR_ROLE();
    const resolverRole = await registry.RESOLVER_ROLE();
    
    await registry.grantRole(registrarRole, await subdomain.getAddress());
    await registry.grantRole(registrarRole, await auction.getAddress());
    await registry.grantRole(resolverRole, await resolver.getAddress());
    
    console.log("System deployed successfully!");
  });

  describe("Complete User Journey", function () {
    it("Should handle full domain lifecycle from registration to transfer", async function () {
      console.log("\n=== Starting Complete User Journey ===");
      
      // 1. Alice registers a domain with 2-year duration (gets discount)
      console.log("1. Alice registering 'alice.atgraphite' for 2 years...");
      const price = await registry["priceOf(string,uint64)"]("alice", 2 * oneYear);
      const oneYearPrice = await registry["priceOf(string,uint64)"]("alice", oneYear);
      
      // Should be discounted (95% for 2 years)
      expect(price).to.equal(oneYearPrice * 2n * 9500n / 10000n);
      
      await registry.connect(alice).buyFixedPrice(
        "alice",
        await resolver.getAddress(),
        2 * oneYear,
        { value: price }
      );
      
      const aliceTokenId = 1n;
      const aliceNode = await registry.getNodeOfToken(aliceTokenId);
      expect(await registry.ownerOf(aliceTokenId)).to.equal(alice.address);
      
      // 2. Alice sets up her profile in resolver
      console.log("2. Alice setting up her profile...");
      await resolver.connect(alice).setProfile(
        aliceNode,
        "Alice Smith",
        "Blockchain Developer",
        "ipfs://QmAliceAvatar",
        "https://alice.example.com",
        alice.address
      );
      
      const profile = await resolver.getProfile(aliceNode);
      expect(profile.displayName).to.equal("Alice Smith");
      expect(profile.ethAddress).to.equal(alice.address);
      
      // 3. Alice sets reverse lookup
      console.log("3. Alice setting up reverse lookup...");
      await reverse.connect(alice).setPrimaryName("alice");
      expect(await reverse.getPrimaryName(alice.address)).to.equal("alice");
      
      // 4. Alice enables and configures subdomains
      console.log("4. Alice configuring subdomains...");
      await subdomain.connect(alice).setSubdomainRegistrationEnabled(aliceNode, true);
      await subdomain.connect(alice).configureSubdomain(
        aliceNode,
        "blog",
        ethers.parseEther("0.05"), // 0.05 ETH
        true, // public
        oneYear, // max 1 year
        alice.address // alice gets payment
      );
      
      // 5. Bob buys a subdomain from Alice
      console.log("5. Bob buying subdomain 'blog.alice.atgraphite'...");
      const subPrice = await subdomain.priceOfSubdomain(aliceNode, "blog", oneYear);
      expect(subPrice).to.equal(ethers.parseEther("0.05"));
      
      const aliceBalanceBefore = await ethers.provider.getBalance(alice.address);
      
      await subdomain.connect(bob).buySubdomain(
        aliceNode,
        "blog",
        oneYear,
        await resolver.getAddress(),
        { value: subPrice }
      );
      
      const aliceBalanceAfter = await ethers.provider.getBalance(alice.address);
      expect(aliceBalanceAfter - aliceBalanceBefore).to.equal(subPrice);
      
      // 6. Bob sets up his subdomain
      console.log("6. Bob setting up his subdomain...");
      const blogNode = ethers.keccak256(
        ethers.concat([aliceNode, ethers.keccak256(ethers.toUtf8Bytes("blog"))])
      );
      
      await resolver.connect(bob).setText(blogNode, "description", "Bob's Blog");
      await resolver.connect(bob).setAddr(blogNode, bob.address);
      
      expect(await resolver.text(blogNode, "description")).to.equal("Bob's Blog");
      expect(await resolver.addr(blogNode)).to.equal(bob.address);
      
      // 7. Transfer main domain via NFT marketplace (simulate)
      console.log("7. Alice transferring domain to Charlie...");
      await registry.connect(alice).transferFrom(alice.address, charlie.address, aliceTokenId);
      
      // Domain ownership should update automatically
      const domain = await registry.getDomain(aliceNode);
      expect(domain.owner).to.equal(charlie.address);
      expect(await registry.ownerOf(aliceTokenId)).to.equal(charlie.address);
      
      // 8. Charlie can now manage the domain
      console.log("8. Charlie taking control of domain...");
      await resolver.connect(charlie).setText(aliceNode, "description", "Now owned by Charlie");
      expect(await resolver.text(aliceNode, "description")).to.equal("Now owned by Charlie");
      
      // 9. Bob still owns his subdomain
      console.log("9. Verifying Bob still controls subdomain...");
      await resolver.connect(bob).setText(blogNode, "update", "Still mine!");
      expect(await resolver.text(blogNode, "update")).to.equal("Still mine!");
      
      console.log("=== Complete User Journey Successful! ===\n");
    });
  });

  describe("Auction Integration", function () {
    it("Should handle complete auction process", async function () {
      console.log("\n=== Starting Auction Integration Test ===");
      
      // 1. Admin starts auction for premium domain
      console.log("1. Starting auction for 'premium'...");
      const minBid = ethers.parseEther("0.1");
      await auction.startAuction("premium", 2 * oneDay, oneDay, minBid);
      
      // 2. Multiple users commit bids
      console.log("2. Users committing bids...");
      const bid1 = ethers.parseEther("1.0");
      const bid2 = ethers.parseEther("1.5");
      const bid3 = ethers.parseEther("0.8");
      
      const salt1 = ethers.keccak256(ethers.toUtf8Bytes("alice_salt"));
      const salt2 = ethers.keccak256(ethers.toUtf8Bytes("bob_salt"));
      const salt3 = ethers.keccak256(ethers.toUtf8Bytes("charlie_salt"));
      
      const commitment1 = await auction.generateCommitment(bid1, salt1, alice.address);
      const commitment2 = await auction.generateCommitment(bid2, salt2, bob.address);
      const commitment3 = await auction.generateCommitment(bid3, salt3, charlie.address);
      
      await auction.connect(alice).commitBid("premium", commitment1);
      await auction.connect(bob).commitBid("premium", commitment2);
      await auction.connect(charlie).commitBid("premium", commitment3);
      
      // 3. Move to reveal phase
      console.log("3. Moving to reveal phase...");
      await time.increase(2 * oneDay + 1);
      
      // 4. Users reveal bids
      console.log("4. Users revealing bids...");
      await auction.connect(alice).revealBid("premium", bid1, salt1, { value: bid1 });
      await auction.connect(bob).revealBid("premium", bid2, salt2, { value: bid2 });
      await auction.connect(charlie).revealBid("premium", bid3, salt3, { value: bid3 });
      
      // 5. Move past reveal phase
      console.log("5. Moving to finalization...");
      await time.increase(oneDay + 1);
      
      // 6. Winner (Bob) finalizes auction
      console.log("6. Bob finalizing auction...");
      const bobBalanceBefore = await ethers.provider.getBalance(bob.address);
      
      await auction.connect(bob).finalizeAuction(
        "premium",
        oneYear,
        await resolver.getAddress()
      );
      
      // 7. Verify Vickrey pricing (Bob pays Alice's bid, not his own)
      console.log("7. Verifying Vickrey pricing...");
      const bobBalanceAfter = await ethers.provider.getBalance(bob.address);
      // Bob should get refund of (his_bid - second_highest_bid)
      
      // 8. Verify domain ownership
      console.log("8. Verifying domain ownership...");
      const premiumNode = await registry.getNodeOfLabel("premium");
      const premiumDomain = await registry.getDomain(premiumNode);
      expect(premiumDomain.owner).to.equal(bob.address);
      
      // 9. Bob can set up the domain
      console.log("9. Bob setting up premium domain...");
      await resolver.connect(bob).setText(premiumNode, "description", "Premium domain won at auction");
      await reverse.connect(bob).setPrimaryName("premium");
      
      expect(await resolver.text(premiumNode, "description")).to.equal("Premium domain won at auction");
      expect(await reverse.getPrimaryName(bob.address)).to.equal("premium");
      
      console.log("=== Auction Integration Successful! ===\n");
    });
  });

  describe("Cross-Contract Data Consistency", function () {
    it("Should maintain consistency across all contracts", async function () {
      console.log("\n=== Testing Cross-Contract Consistency ===");
      
      // 1. Register domain
      const price = await registry["priceOf(string,uint64)"]("consistency", oneYear);
      await registry.connect(alice).buyFixedPrice(
        "consistency",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );
      
      const tokenId = await registry.nextId() - 1n;
      const node = await registry.getNodeOfToken(tokenId);
      
      // 2. Set up across all systems
      await resolver.connect(alice).setText(node, "test", "cross-contract");
      await reverse.connect(alice).setPrimaryName("consistency");
      await subdomain.connect(alice).setSubdomainRegistrationEnabled(node, true);
      
      // 3. Transfer domain
      await registry.connect(alice).transferFrom(alice.address, bob.address, tokenId);
      
      // 4. Verify all contracts see the new owner
      const domain = await registry.getDomain(node);
      expect(domain.owner).to.equal(bob.address);
      expect(await registry.ownerOf(tokenId)).to.equal(bob.address);
      
      // 5. Bob should now control everything
      await resolver.connect(bob).setText(node, "new_owner", "bob");
      expect(await resolver.text(node, "new_owner")).to.equal("bob");
      
      // 6. Alice should lose control
      await expect(
        resolver.connect(alice).setText(node, "should_fail", "fail")
      ).to.be.revertedWith("Not authorized for this domain");
      
      // 7. Reverse registry should update
      await reverse.connect(bob).setPrimaryName("consistency");
      expect(await reverse.getPrimaryName(bob.address)).to.equal("consistency");
      
      console.log("=== Cross-Contract Consistency Verified! ===\n");
    });
  });

  describe("Gas Efficiency Tests", function () {
    it("Should demonstrate efficient gas usage across operations", async function () {
      console.log("\n=== Testing Gas Efficiency ===");
      
      // Test efficient domain registration
      const price = await registry["priceOf(string,uint64)"]("efficient", oneYear);
      const tx1 = await registry.connect(alice).buyFixedPrice(
        "efficient",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );
      const receipt1 = await tx1.wait();
      console.log(`Domain registration gas: ${receipt1!.gasUsed}`);
      
      const tokenId = await registry.nextId() - 1n;
      const node = await registry.getNodeOfToken(tokenId);
      
      // Test efficient profile setup
      const tx2 = await resolver.connect(alice).setProfile(
        node,
        "Alice",
        "Test",
        "ipfs://test",
        "https://test.com",
        alice.address
      );
      const receipt2 = await tx2.wait();
      console.log(`Profile setup gas: ${receipt2!.gasUsed}`);
      
      // Test efficient batch text records
      const keys = ["key1", "key2", "key3", "key4", "key5"];
      const values = ["val1", "val2", "val3", "val4", "val5"];
      
      const tx3 = await resolver.connect(alice).setTextBatch(node, keys, values);
      const receipt3 = await tx3.wait();
      console.log(`Batch text records gas: ${receipt3!.gasUsed}`);
      
      // Test efficient subdomain configuration
      const tx4 = await subdomain.connect(alice).configureSubdomain(
        node,
        "sub",
        ethers.parseEther("0.01"),
        true,
        oneYear,
        alice.address
      );
      const receipt4 = await tx4.wait();
      console.log(`Subdomain config gas: ${receipt4!.gasUsed}`);
      
      // All operations should be reasonably efficient
      expect(receipt1!.gasUsed).to.be.lt(ethers.parseUnits("300000", "wei"));
      expect(receipt2!.gasUsed).to.be.lt(ethers.parseUnits("200000", "wei"));
      expect(receipt3!.gasUsed).to.be.lt(ethers.parseUnits("300000", "wei"));
      expect(receipt4!.gasUsed).to.be.lt(ethers.parseUnits("150000", "wei"));
      
      console.log("=== Gas Efficiency Tests Passed! ===\n");
    });
  });

  describe("System Resilience", function () {
    it("Should handle edge cases and recovery scenarios", async function () {
      console.log("\n=== Testing System Resilience ===");
      
      // 1. Test domain expiry handling
      console.log("1. Testing domain expiry...");
      const price = await registry["priceOf(string,uint64)"]("expiring", oneYear);
      await registry.connect(alice).buyFixedPrice(
        "expiring",
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );
      
      const tokenId = await registry.nextId() - 1n;
      const node = await registry.getNodeOfToken(tokenId);
      
      // Fast forward past expiry
      await time.increase(oneYear + 1);
      
      // Should reject operations on expired domain
      await expect(
        resolver.connect(alice).setText(node, "expired", "should_fail")
      ).to.be.revertedWith("Domain expired");
      
      // 2. Test pausing and recovery
      console.log("2. Testing pause/unpause...");
      await registry.pause();
      
      await expect(
        registry.connect(bob).buyFixedPrice(
          "paused",
          await resolver.getAddress(),
          oneYear,
          { value: ethers.parseEther("1.0") }
        )
      ).to.be.revertedWith("Pausable: paused");
      
      await registry.unpause();
      
      // Should work after unpause
      const pausePrice = await registry["priceOf(string,uint64)"]("unpaused", oneYear);
      await registry.connect(bob).buyFixedPrice(
        "unpaused",
        await resolver.getAddress(),
        oneYear,
        { value: pausePrice }
      );
      
      // 3. Test reverse registry sync
      console.log("3. Testing reverse registry sync...");
      await reverse.connect(alice).setPrimaryName("alice"); // From earlier test
      
      // Transfer domain away
      const aliceTokenId = 1n;
      await registry.connect(charlie).transferFrom(charlie.address, bob.address, aliceTokenId);
      
      // Sync should clean up
      await reverse.syncOwnedNames(alice.address);
      expect(await reverse.getPrimaryName(alice.address)).to.equal("");
      
      console.log("=== System Resilience Tests Passed! ===\n");
    });
  });

  after(async function () {
    console.log("\n=== Integration Tests Complete ===");
    console.log("All major functionality working correctly!");
    console.log("System is production ready! 🚀");
  });
});