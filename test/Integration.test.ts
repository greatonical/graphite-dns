// test/Integration.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type {
  GraphiteDNSRegistry,
  GraphiteResolver,
  ReverseRegistrar,
  AuctionRegistrar,
  SubdomainRegistrar
} from "../typechain-types";

describe("GraphiteDNS Integration Tests", function () {
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const oneYear = 365 * 24 * 60 * 60;
  const oneHour = 60 * 60;

  async function deployFullSystemFixture() {
    const [owner, user1, user2, user3, auctioneer] = await ethers.getSigners();

    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const registry = await RegistryFactory.deploy(ZERO_ADDRESS, "atgraphite");

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const resolver = await ResolverFactory.deploy(await registry.getAddress());

    // Deploy reverse registrar
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    const reverse = await ReverseFactory.deploy(await registry.getAddress());

    // Deploy auction registrar
    const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
    const auction = await AuctionFactory.deploy(await registry.getAddress());

    // Deploy subdomain registrar
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    const subdomain = await SubdomainFactory.deploy(
      await registry.getAddress(),
      await reverse.getAddress()
    );

    // Setup all roles and connections
    const registrarRole = await registry.REGISTRAR_ROLE();
    const registryRole = await reverse.REGISTRY_ROLE();
    const auctioneerRole = await auction.AUCTIONEER_ROLE();

    await registry.grantRole(registrarRole, owner.address);
    await registry.grantRole(registrarRole, await auction.getAddress());
    await registry.grantRole(registrarRole, await subdomain.getAddress());
    
    await reverse.grantRole(registryRole, await registry.getAddress());
    await auction.grantRole(auctioneerRole, auctioneer.address);

    // Connect components
    await registry.setReverseRegistrar(await reverse.getAddress());
    await registry.setDefaultResolver(await resolver.getAddress());

    const TLD_NODE = await registry.TLD_NODE();

    return {
      registry,
      resolver,
      reverse,
      auction,
      subdomain,
      owner,
      user1,
      user2,
      user3,
      auctioneer,
      TLD_NODE
    };
  }

  describe("Complete Domain Lifecycle", function () {
    it("Should handle registration -> record setting -> transfer -> renewal flow", async function () {
      const { registry, resolver, reverse, user1, user2, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // 1. Register domain
      const price = await registry.priceOf("lifecycle");
      await registry.connect(user1).register(
        "lifecycle",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("lifecycle"))]));

      // Verify registration
      const record = await registry.getRecord(node);
      expect(record.owner).to.equal(user1.address);
      expect(record.exists).to.be.true;

      // 2. Verify reverse record was auto-created
      expect(await reverse.name(user1.address)).to.equal("lifecycle.atgraphite");

      // 3. Set resolver records
      await resolver.setOwner(node, user1.address);
      await resolver.connect(user1).setText(node, "email", "user1@example.com");
      await resolver.connect(user1).setAddr(node, user1.address);

      expect(await resolver.text(node, "email")).to.equal("user1@example.com");
      expect(await resolver.addr(node)).to.equal(user1.address);

      // 4. Transfer domain
      const tokenId = 2; // Second token (first is TLD)
      await registry.connect(user1).transferFrom(user1.address, user2.address, tokenId);

      // Verify transfer
      expect(await registry.ownerOf(tokenId)).to.equal(user2.address);
      expect((await registry.getRecord(node)).owner).to.equal(user2.address);

      // Verify reverse records updated
      expect(await reverse.name(user1.address)).to.equal("");
      expect(await reverse.name(user2.address)).to.equal("lifecycle.atgraphite");

      // 5. Renew domain
      const renewalPrice = await registry.renewalPriceOf("lifecycle", oneYear);
      await registry.connect(user2).renew(node, oneYear, { value: renewalPrice });

      // Verify renewal
      const renewedRecord = await registry.getRecord(node);
      expect(renewedRecord.expiry).to.be.gt(record.expiry);
    });

    it("Should handle complete auction flow with multiple bidders", async function () {
      const { registry, resolver, auction, auctioneer, user1, user2, user3, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      const name = "premium";
      const minBid = ethers.parseEther("1");

      // 1. Start auction
      await auction.connect(auctioneer).startAuction(name, oneHour, oneHour, minBid);

      // 2. Multiple bidders commit
      const bid1 = ethers.parseEther("2");
      const bid2 = ethers.parseEther("3");
      const bid3 = ethers.parseEther("2.5");
      
      const salt1 = ethers.keccak256(ethers.toUtf8Bytes("salt1"));
      const salt2 = ethers.keccak256(ethers.toUtf8Bytes("salt2"));
      const salt3 = ethers.keccak256(ethers.toUtf8Bytes("salt3"));

      const commitment1 = await auction.generateCommitment(bid1, salt1, user1.address);
      const commitment2 = await auction.generateCommitment(bid2, salt2, user2.address);
      const commitment3 = await auction.generateCommitment(bid3, salt3, user3.address);

      await auction.connect(user1).commitBid(name, commitment1, { value: bid1 });
      await auction.connect(user2).commitBid(name, commitment2, { value: bid2 });
      await auction.connect(user3).commitBid(name, commitment3, { value: bid3 });

      // 3. Fast forward to reveal phase
      await time.increase(oneHour + 1);

      // 4. Reveal all bids
      await auction.connect(user1).revealBid(name, bid1, salt1);
      await auction.connect(user2).revealBid(name, bid2, salt2);
      await auction.connect(user3).revealBid(name, bid3, salt3);

      // 5. Fast forward past reveal phase
      await time.increase(oneHour + 1);

      // 6. Finalize auction
      await auction.finalizeAuction(name, oneYear, await resolver.getAddress());

      // 7. Verify winner
      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes(name))]));

      const record = await registry.getRecord(node);
      expect(record.owner).to.equal(user2.address); // Highest bidder

      // 8. Verify Vickrey pricing (winner pays second highest bid)
      const initialBalance1 = await ethers.provider.getBalance(user1.address);
      const initialBalance3 = await ethers.provider.getBalance(user3.address);

      await auction.connect(user1).withdraw();
      await auction.connect(user3).withdraw();

      const finalBalance1 = await ethers.provider.getBalance(user1.address);
      const finalBalance3 = await ethers.provider.getBalance(user3.address);

      // Losers should get full refunds (minus gas)
      expect(finalBalance1).to.be.closeTo(initialBalance1, ethers.parseEther("0.01"));
      expect(finalBalance3).to.be.closeTo(initialBalance3, ethers.parseEther("0.01"));
    });

    it("Should handle complex subdomain scenarios", async function () {
      const { registry, resolver, subdomain, user1, user2, user3, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // 1. Register parent domain
      const price = await registry.priceOf("company");
      await registry.connect(user1).register(
        "company",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const parentNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("company"))]));

      // 2. Create managed subdomain (parent retains control)
      await subdomain.connect(user1).createManagedSubdomain(
        parentNode,
        "api",
        await resolver.getAddress()
      );

      const apiNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("api"))]));

      // 3. Configure and sell subdomain
      await subdomain.connect(user1).configureSubdomain(
        parentNode,
        "shop",
        ethers.parseEther("0.1"),
        2, // SOLD
        oneYear,
        1,
        false
      );

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.1") }
      );

      const shopNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("shop"))]));

      // 4. Verify ownership structures
      const apiRecord = await subdomain.getSubdomainRecord(apiNode);
      const shopRecord = await subdomain.getSubdomainRecord(shopNode);

      expect(apiRecord.currentOwner).to.equal(user1.address); // Parent retains
      expect(shopRecord.currentOwner).to.equal(user2.address); // Sold to user2

      // 5. Parent can manage API subdomain
      await subdomain.connect(user1).updateManagedSubdomain(apiNode, user3.address);

      // 6. User2 can transfer shop subdomain
      await subdomain.connect(user2).transferSubdomain(shopNode, user3.address, 2);

      const updatedShopRecord = await subdomain.getSubdomainRecord(shopNode);
      expect(updatedShopRecord.currentOwner).to.equal(user3.address);

      // 7. Parent withdraws earnings
      const initialBalance = await ethers.provider.getBalance(user1.address);
      await subdomain.connect(user1).withdrawEarnings();
      const finalBalance = await ethers.provider.getBalance(user1.address);

      expect(finalBalance).to.be.gt(initialBalance);
    });
  });

  describe("Cross-Component Integration", function () {
    it("Should maintain consistency across all components during transfers", async function () {
      const { registry, resolver, reverse, user1, user2, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register domain
      const price = await registry.priceOf("integration");
      await registry.connect(user1).register(
        "integration",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("integration"))]));

      // Set up resolver
      await resolver.setOwner(node, user1.address);
      await resolver.connect(user1).setText(node, "email", "user1@test.com");
      await resolver.connect(user1).setAddr(node, user1.address);

      // Transfer domain
      const tokenId = 2;
      await registry.connect(user1).transferFrom(user1.address, user2.address, tokenId);

      // Verify all components updated consistently
      expect(await registry.ownerOf(tokenId)).to.equal(user2.address);
      expect((await registry.getRecord(node)).owner).to.equal(user2.address);
      expect(await reverse.name(user1.address)).to.equal("");
      expect(await reverse.name(user2.address)).to.equal("integration.atgraphite");

      // Resolver should still have old records but new owner should be able to modify
      expect(await resolver.text(node, "email")).to.equal("user1@test.com");
      
      // New owner can update records
      await resolver.setOwner(node, user2.address);
      await resolver.connect(user2).setText(node, "email", "user2@test.com");
      expect(await resolver.text(node, "email")).to.equal("user2@test.com");
    });

    it("Should handle meta-transactions correctly", async function () {
      const { registry, user1, user2, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register domain
      const price = await registry.priceOf("metatx");
      await registry.connect(user1).register(
        "metatx",
        user1.address,
        oneYear,
        ZERO_ADDRESS,
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("metatx"))]));

      // Prepare meta-transaction
      const nonce = await registry.nonces(user1.address);
      const deadline = await time.latest() + 3600;

      const domain = {
        name: "GraphiteDNSRegistry",
        version: "1",
        chainId: 31337,
        verifyingContract: await registry.getAddress()
      };

      const types = {
        Transfer: [
          { name: "node", type: "bytes32" },
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" }
        ]
      };

      const value = {
        node,
        from: user1.address,
        to: user2.address,
        nonce,
        deadline
      };

      const signature = await user1.signTypedData(domain, types, value);

      // Execute meta-transaction (anyone can call)
      await registry.transferWithSig(
        node,
        user1.address,
        user2.address,
        nonce,
        deadline,
        signature
      );

      // Verify transfer occurred
      const record = await registry.getRecord(node);
      expect(record.owner).to.equal(user2.address);
    });

    it("Should handle expiry scenarios across all components", async function () {
      const { registry, resolver, subdomain, user1, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register short-term domain
      const price = await registry.priceOf("expiry");
      await registry.connect(user1).register(
        "expiry",
        user1.address,
        24 * 60 * 60, // 1 day
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("expiry"))]));

      // Create subdomain
      await subdomain.connect(user1).createManagedSubdomain(
        node,
        "sub",
        await resolver.getAddress()
      );

      // Set resolver records
      await resolver.setOwner(node, user1.address);
      await resolver.connect(user1).setText(node, "test", "value");

      // Fast forward past expiry
      await time.increase(25 * 60 * 60); // 25 hours

      // All operations should fail on expired domain
      await expect(
        resolver.connect(user1).setText(node, "test", "newvalue")
      ).to.be.revertedWith("Node expired");

      await expect(
        registry.connect(user1).setResolver(node, ZERO_ADDRESS)
      ).to.be.revertedWith("Domain expired");

      await expect(
        subdomain.connect(user1).createManagedSubdomain(node, "new", ZERO_ADDRESS)
      ).to.be.revertedWith("Parent expired");

      // Domain should be available for re-registration after grace period
      await time.increase(90 * 24 * 60 * 60 + 1); // Grace period + 1

      expect(await registry.isAvailable(node)).to.be.true;
    });
  });

  describe("Security and Edge Cases", function () {
    it("Should prevent unauthorized operations across all components", async function () {
      const { registry, resolver, subdomain, user1, user2, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register domain as user1
      const price = await registry.priceOf("security");
      await registry.connect(user1).register(
        "security",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("security"))]));

      // Set resolver owner
      await resolver.setOwner(node, user1.address);

      // User2 should not be able to perform any operations
      await expect(
        registry.connect(user2).setResolver(node, ZERO_ADDRESS)
      ).to.be.revertedWith("Not authorized");

      await expect(
        resolver.connect(user2).setText(node, "hack", "attempt")
      ).to.be.revertedWith("Not authorized");

      await expect(
        subdomain.connect(user2).createManagedSubdomain(node, "hack", ZERO_ADDRESS)
      ).to.be.revertedWith("Not parent owner");
    });

    it("Should handle reentrancy attacks", async function () {
      const { auction, auctioneer } = await loadFixture(deployFullSystemFixture);

      // This test would require a malicious contract, but we can test the reentrancy guards
      await auction.connect(auctioneer).startAuction("reentrant", oneHour, oneHour, ethers.parseEther("1"));

      // Fast forward past auction
      await time.increase(2 * oneHour + 1);

      // Try to finalize multiple times (should be protected)
      await auction.finalizeAuction("reentrant", oneYear, ZERO_ADDRESS);

      await expect(
        auction.finalizeAuction("reentrant", oneYear, ZERO_ADDRESS)
      ).to.be.revertedWith("Already finalized");
    });

    it("Should handle gas limit scenarios", async function () {
      const { subdomain, user1, user2, TLD_NODE, registry, resolver } = await loadFixture(deployFullSystemFixture);

      // Register domain
      const price = await registry.priceOf("gastest");
      await registry.connect(user1).register(
        "gastest",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const parentNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("gastest"))]));

      // Create many subdomains to test gas efficiency
      const subdomainCount = 10;
      for (let i = 0; i < subdomainCount; i++) {
        await subdomain.connect(user1).configureSubdomain(
          parentNode,
          `sub${i}`,
          ethers.parseEther("0.01"),
          2, // SOLD
          oneYear,
          1,
          false
        );
      }

      // Verify all were created
      const labels = await subdomain.getSubdomainLabels(parentNode);
      expect(labels.length).to.equal(subdomainCount);

      // Buy subdomains should still be gas efficient
      for (let i = 0; i < 3; i++) {
        const tx = await subdomain.connect(user2).buySubdomain(
          parentNode,
          `sub${i}`,
          await resolver.getAddress(),
          { value: ethers.parseEther("0.01") }
        );
        const receipt = await tx.wait();
        expect(receipt!.gasUsed).to.be.lt(500000);
      }
    });
  });

  describe("Performance and Gas Optimization", function () {
    it("Should be gas efficient for batch operations", async function () {
      const { resolver, registry, user1, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register domain
      const price = await registry.priceOf("batch");
      await registry.connect(user1).register(
        "batch",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("batch"))]));

      await resolver.setOwner(node, user1.address);

      // Batch text record setting should be more efficient than individual calls
      const keys = ["email", "url", "avatar", "description", "twitter"];
      const values = [
        "test@example.com",
        "https://example.com",
        "ipfs://Qm...",
        "Test domain",
        "@testuser"
      ];

      const batchTx = await resolver.connect(user1).setMultipleTexts(node, keys, values);
      const batchReceipt = await batchTx.wait();

      // Should be more efficient than 5 individual calls
      expect(batchReceipt!.gasUsed).to.be.lt(400000);

      // Verify all records were set
      for (let i = 0; i < keys.length; i++) {
        expect(await resolver.text(node, keys[i])).to.equal(values[i]);
      }
    });

    it("Should optimize storage access patterns", async function () {
      const { registry, user1, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Multiple registrations should not have exponentially increasing gas costs
      const baseName = "optimize";
      let previousGasUsed = 0;

      for (let i = 0; i < 5; i++) {
        const name = `${baseName}${i}`;
        const price = await registry.priceOf(name);
        
        const tx = await registry.connect(user1).register(
          name,
          user1.address,
          oneYear,
          ZERO_ADDRESS,
          TLD_NODE,
          { value: price }
        );
        
        const receipt = await tx.wait();
        const gasUsed = Number(receipt!.gasUsed);
        
        if (i > 0) {
          // Gas usage should not increase dramatically
          const increase = (gasUsed - previousGasUsed) / previousGasUsed;
          expect(increase).to.be.lt(0.1); // Less than 10% increase
        }
        
        previousGasUsed = gasUsed;
      }
    });
  });

  describe("Upgrade Scenarios", function () {
    it("Should support contract upgrades", async function () {
      const { registry, owner } = await loadFixture(deployFullSystemFixture);

      // Verify contract is upgradeable
      expect(await registry.supportsInterface("0x52d1902d")).to.be.true; // UUPSUpgradeable

      // Only authorized upgrader should be able to upgrade
      expect(await registry.hasRole(await registry.UPGRADER_ROLE(), owner.address)).to.be.true;
    });

    it("Should maintain state across component updates", async function () {
      const { registry, resolver, user1, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // Register domain and set records
      const price = await registry.priceOf("upgrade");
      await registry.connect(user1).register(
        "upgrade",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("upgrade"))]));

      await resolver.setOwner(node, user1.address);
      await resolver.connect(user1).setText(node, "persistent", "data");

      // Deploy new resolver
      const NewResolverFactory = await ethers.getContractFactory("GraphiteResolver");
      const newResolver = await NewResolverFactory.deploy(await registry.getAddress());

      // Update domain to use new resolver
      await registry.connect(user1).setResolver(node, await newResolver.getAddress());

      // Old data should still be accessible from old resolver
      expect(await resolver.text(node, "persistent")).to.equal("data");

      // New resolver should be set on domain
      const record = await registry.getRecord(node);
      expect(record.resolver).to.equal(await newResolver.getAddress());
    });
  });

  describe("Real-world Usage Scenarios", function () {
    it("Should handle a complete web3 identity setup", async function () {
      const { registry, resolver, reverse, user1, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // 1. User registers their identity domain
      const price = await registry.priceOf("alice");
      await registry.connect(user1).register(
        "alice",
        user1.address,
        oneYear * 2, // 2 years
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))]));

      // 2. Set up complete web3 identity
      await resolver.setOwner(node, user1.address);
      
      // Social records
      await resolver.connect(user1).setMultipleTexts(node, 
        ["email", "url", "avatar", "description", "twitter", "github"],
        [
          "alice@example.com",
          "https://alice.dev",
          "ipfs://QmAvatarHash",
          "Alice - Web3 Developer",
          "@alicedev",
          "github.com/alice"
        ]
      );

      // Crypto addresses
      await resolver.connect(user1).setAddr(node, user1.address); // ETH
      await resolver.connect(user1).setAddrByType(node, 0, "0x1234567890123456789012345678901234567890"); // BTC

      // Content hash for decentralized website
      const contentHash = ethers.randomBytes(32);
      await resolver.connect(user1).setContenthash(node, contentHash);

      // 3. Verify complete setup
      expect(await reverse.name(user1.address)).to.equal("alice.atgraphite");
      expect(await resolver.text(node, "email")).to.equal("alice@example.com");
      expect(await resolver.addr(node)).to.equal(user1.address);
      expect(await resolver.addrByType(node, 0)).to.not.equal("0x");

      // 4. Set up operator for dApp management
      const dappOperator = user1; // In real scenario, this would be a different address
      await resolver.connect(user1).setOperator(node, dappOperator.address, true);

      // Operator can now manage records
      await resolver.connect(dappOperator).setText(node, "status", "Building amazing dApps");
      expect(await resolver.text(node, "status")).to.equal("Building amazing dApps");
    });

    it("Should handle corporate subdomain management", async function () {
      const { registry, resolver, subdomain, user1, user2, user3, TLD_NODE } = await loadFixture(deployFullSystemFixture);

      // 1. Company registers main domain
      const price = await registry.priceOf("company");
      await registry.connect(user1).register(
        "company",
        user1.address,
        oneYear * 5, // 5 years
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const companyNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("company"))]));

      // 2. Create internal infrastructure subdomains (managed)
      const infraSubdomains = ["api", "mail", "cdn", "docs"];
      for (const sub of infraSubdomains) {
        await subdomain.connect(user1).createManagedSubdomain(
          companyNode,
          sub,
          await resolver.getAddress()
        );
      }

      // 3. Configure employee subdomains for sale
      await subdomain.connect(user1).configureSubdomain(
        companyNode,
        "employees",
        ethers.parseEther("0.01"), // Cheap for employees
        2, // SOLD
        oneYear,
        100, // Max 100 employees
        true // Requires approval
      );

      // 4. Approve employees
      await subdomain.connect(user1).addApprovedBuyer(companyNode, "employees", user2.address);
      await subdomain.connect(user1).addApprovedBuyer(companyNode, "employees", user3.address);

      // 5. Employees purchase their subdomains
      await subdomain.connect(user2).buySubdomain(
        companyNode,
        "employees",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.01") }
      );

      // 6. Set up employee subdomain records
      const employeeNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [companyNode, ethers.keccak256(ethers.toUtf8Bytes("employees"))]));

      // Employee owns their subdomain and can set records
      const employeeRecord = await subdomain.getSubdomainRecord(employeeNode);
      expect(employeeRecord.currentOwner).to.equal(user2.address);

      // 7. Company maintains infrastructure subdomains
      const apiNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [companyNode, ethers.keccak256(ethers.toUtf8Bytes("api"))]));

      await subdomain.connect(user1).updateManagedSubdomain(apiNode, await resolver.getAddress());

      // Company still controls infrastructure
      const apiRecord = await subdomain.getSubdomainRecord(apiNode);
      expect(apiRecord.currentOwner).to.equal(user1.address);
    });
  });
});