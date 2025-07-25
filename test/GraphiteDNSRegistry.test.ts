// test/GraphiteDNSRegistry.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { GraphiteDNSRegistry, GraphiteResolver } from "../typechain-types";

describe("GraphiteDNSRegistry", function () {
  // Test constants
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const ZERO_HASH = ethers.ZeroHash;
  const oneYear = 365 * 24 * 60 * 60;
  const oneDay = 24 * 60 * 60;
  const gracePeriod = 90 * 24 * 60 * 60;

  async function deployRegistryFixture() {
    const [owner, user1, user2, user3, registrar] = await ethers.getSigners();

    // Deploy resolver first (placeholder)
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const resolver = await ResolverFactory.deploy(ZERO_ADDRESS);

    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const registry = await RegistryFactory.deploy(await resolver.getAddress(), "atgraphite");

    // Deploy actual resolver with registry address
    const finalResolver = await ResolverFactory.deploy(await registry.getAddress());

    // Update registry's default resolver
    await registry.setDefaultResolver(await finalResolver.getAddress());

    const TLD_NODE = await registry.TLD_NODE();

    return {
      registry,
      resolver: finalResolver,
      owner,
      user1,
      user2,
      user3,
      registrar,
      TLD_NODE
    };
  }

  describe("Deployment", function () {
    it("Should deploy with correct initial state", async function () {
      const { registry, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      expect(await registry.name()).to.equal("Graphite DNS");
      expect(await registry.symbol()).to.equal("GDNS");
      expect(await registry.hasRole(await registry.DEFAULT_ADMIN_ROLE(), owner.address)).to.be.true;
      expect(await registry.TLD_NODE()).to.equal(TLD_NODE);
    });

    it("Should create TLD domain on deployment", async function () {
      const { registry, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const tldRecord = await registry.getRecord(TLD_NODE);
      expect(tldRecord.owner).to.equal(owner.address);
      expect(tldRecord.exists).to.be.true;
      expect(await registry.ownerOf(1)).to.equal(owner.address); // First token is TLD
    });

    it("Should set correct length premiums", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);

      expect(await registry.lengthPremium(1)).to.equal(ethers.parseEther("1"));
      expect(await registry.lengthPremium(2)).to.equal(ethers.parseEther("0.5"));
      expect(await registry.lengthPremium(3)).to.equal(ethers.parseEther("0.1"));
      expect(await registry.lengthPremium(4)).to.equal(ethers.parseEther("0.05"));
    });
  });

  describe("Registration", function () {
    it("Should register domain with correct parameters", async function () {
      const { registry, resolver, user1, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const price = await registry.priceOf("alice");
      
      await expect(
        registry.connect(user1).register(
          "alice",
          user1.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.emit(registry, "DomainRegistered")
       .withArgs(
         ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
         [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))])),
         "alice",
         user1.address,
         await time.latest() + oneYear,
         price
       );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))]));
      
      const record = await registry.getRecord(node);
      expect(record.owner).to.equal(user1.address);
      expect(record.exists).to.be.true;
    });

    it("Should fail registration without REGISTRAR_ROLE", async function () {
      const { registry, resolver, user1, TLD_NODE } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(user1).register(
          "alice",
          user1.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE
        )
      ).to.be.revertedWith("AccessControl:");
    });

    it("Should fail registration with insufficient payment", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const price = await registry.priceOf("alice");
      
      await expect(
        registry.register(
          "alice",
          owner.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price - 1n }
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should refund excess payment", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const price = await registry.priceOf("alice");
      const excess = ethers.parseEther("1");
      const initialBalance = await ethers.provider.getBalance(owner.address);

      const tx = await registry.register(
        "alice",
        owner.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price + excess }
      );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const finalBalance = await ethers.provider.getBalance(owner.address);

      // Should only pay the actual price plus gas
      expect(finalBalance).to.be.closeTo(
        initialBalance - price - gasUsed,
        ethers.parseEther("0.001") // Small tolerance for gas estimation differences
      );
    });

    it("Should prevent registration of invalid names", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      // Empty name
      await expect(
        registry.register("", owner.address, oneYear, await resolver.getAddress(), TLD_NODE)
      ).to.be.revertedWith("Invalid name length");

      // Too long name
      const longName = "a".repeat(64);
      await expect(
        registry.register(longName, owner.address, oneYear, await resolver.getAddress(), TLD_NODE)
      ).to.be.revertedWith("Invalid name length");

      // Invalid characters
      await expect(
        registry.register("alice!", owner.address, oneYear, await resolver.getAddress(), TLD_NODE)
      ).to.be.revertedWith("Invalid name format");
    });

    it("Should prevent registration of unavailable domains", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const price = await registry.priceOf("alice");

      // Register domain first
      await registry.register(
        "alice",
        owner.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      // Try to register again should fail
      await expect(
        registry.register(
          "alice",
          owner.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.be.revertedWith("Name not available");
    });

    it("Should enforce duration limits", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const minDuration = 28 * 24 * 60 * 60; // 28 days
      const maxDuration = 10 * 365 * 24 * 60 * 60; // 10 years

      // Too short duration
      await expect(
        registry.register(
          "short",
          owner.address,
          minDuration - 1,
          await resolver.getAddress(),
          TLD_NODE
        )
      ).to.be.revertedWith("Invalid duration");

      // Too long duration
      await expect(
        registry.register(
          "long",
          owner.address,
          maxDuration + 1,
          await resolver.getAddress(),
          TLD_NODE
        )
      ).to.be.revertedWith("Invalid duration");
    });
  });

  describe("Pricing", function () {
    it("Should calculate correct base price", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);

      const baseFee = await registry.baseFee();
      const maxLength = await registry.MAX_NAME_LENGTH();

      // Check pricing for different lengths
      const price5 = await registry.priceOf("alice"); // 5 chars
      const price10 = await registry.priceOf("1234567890"); // 10 chars

      expect(price5).to.be.gt(price10); // Shorter names cost more
    });

    it("Should apply length premiums correctly", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);

      const price1 = await registry.priceOf("a");
      const price2 = await registry.priceOf("ab"); 
      const price3 = await registry.priceOf("abc");
      const price5 = await registry.priceOf("alice");

      // 1-char should be most expensive
      expect(price1).to.be.gt(price2);
      expect(price2).to.be.gt(price3);
      expect(price3).to.be.gt(price5);
    });

    it("Should honor custom pricing", async function () {
      const { registry, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const customPrice = ethers.parseEther("10");
      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("premium"))]));

      await registry.setCustomPrice(node, customPrice);
      
      expect(await registry.priceOf("premium")).to.equal(customPrice);
    });

    it("Should calculate renewal pricing differently", async function () {
      const { registry } = await loadFixture(deployRegistryFixture);

      const registerPrice = await registry.priceOf("alice");
      const renewalPrice = await registry.renewalPriceOf("alice", oneYear);

      expect(renewalPrice).to.be.lt(registerPrice); // Renewals should be cheaper
    });
  });

  describe("Domain Management", function () {
    async function registerDomainFixture() {
      const base = await loadFixture(deployRegistryFixture);
      const { registry, resolver, user1, TLD_NODE } = base;

      const price = await registry.priceOf("alice");
      await registry.register(
        "alice",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))]));

      return { ...base, node };
    }

    it("Should allow owner to set resolver", async function () {
      const { registry, user1, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        registry.connect(user1).setResolver(node, user2.address)
      ).to.emit(registry, "ResolverChanged")
       .withArgs(node, user2.address);

      const record = await registry.getRecord(node);
      expect(record.resolver).to.equal(user2.address);
    });

    it("Should prevent non-owner from setting resolver", async function () {
      const { registry, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        registry.connect(user2).setResolver(node, user2.address)
      ).to.be.revertedWith("Not authorized");
    });

    it("Should prevent operations on expired domains", async function () {
      const { registry, user1, node } = await loadFixture(registerDomainFixture);

      // Fast forward past expiry
      await time.increase(oneYear + 1);

      await expect(
        registry.connect(user1).setResolver(node, user1.address)
      ).to.be.revertedWith("Domain expired");
    });
  });

  describe("Renewal", function () {
    async function expiredDomainFixture() {
      const base = await loadFixture(registerDomainFixture);
      const { registry, user1, node } = base;

      // Fast forward to near expiry
      await time.increase(oneYear - oneDay);

      return { ...base };
    }

    it("Should allow domain renewal before expiry", async function () {
      const { registry, user1, node } = await loadFixture(expiredDomainFixture);

      const renewalCost = await registry.renewalPriceOf("alice", oneYear);
      const oldRecord = await registry.getRecord(node);

      await expect(
        registry.connect(user1).renew(node, oneYear, { value: renewalCost })
      ).to.emit(registry, "DomainRenewed");

      const newRecord = await registry.getRecord(node);
      expect(newRecord.expiry).to.be.gt(oldRecord.expiry);
    });

    it("Should allow renewal during grace period", async function () {
      const { registry, user1, node } = await loadFixture(expiredDomainFixture);

      // Fast forward past expiry but within grace period
      await time.increase(oneDay * 2);

      const renewalCost = await registry.renewalPriceOf("alice", oneYear);

      await expect(
        registry.connect(user1).renew(node, oneYear, { value: renewalCost })
      ).to.not.be.reverted;
    });

    it("Should prevent renewal after grace period", async function () {
      const { registry, user1, node } = await loadFixture(expiredDomainFixture);

      // Fast forward past grace period
      await time.increase(oneDay * 2 + gracePeriod);

      const renewalCost = await registry.renewalPriceOf("alice", oneYear);

      await expect(
        registry.connect(user1).renew(node, oneYear, { value: renewalCost })
      ).to.be.revertedWith("Grace period expired");
    });

    it("Should prevent non-owner from renewing", async function () {
      const { registry, user2, node } = await loadFixture(expiredDomainFixture);

      const renewalCost = await registry.renewalPriceOf("alice", oneYear);

      await expect(
        registry.connect(user2).renew(node, oneYear, { value: renewalCost })
      ).to.be.revertedWith("Not authorized to renew");
    });
  });

  describe("Transfers", function () {
    it("Should transfer domain ownership", async function () {
      const { registry, user1, user2, node } = await loadFixture(registerDomainFixture);

      const tokenId = 2; // Second token (first is TLD)

      await expect(
        registry.connect(user1).transferFrom(user1.address, user2.address, tokenId)
      ).to.emit(registry, "DomainTransferred")
       .withArgs(node, user1.address, user2.address);

      expect(await registry.ownerOf(tokenId)).to.equal(user2.address);
      
      const record = await registry.getRecord(node);
      expect(record.owner).to.equal(user2.address);
    });

    it("Should support meta-transactions for transfers", async function () {
      const { registry, user1, user2, node } = await loadFixture(registerDomainFixture);

      const nonce = await registry.nonces(user1.address);
      const deadline = await time.latest() + 3600;

      // Create signature
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

      await expect(
        registry.transferWithSig(node, user1.address, user2.address, nonce, deadline, signature)
      ).to.emit(registry, "DomainTransferred");
    });
  });

  describe("Access Control", function () {
    it("Should have correct initial roles", async function () {
      const { registry, owner } = await loadFixture(deployRegistryFixture);

      const adminRole = await registry.DEFAULT_ADMIN_ROLE();
      const registrarRole = await registry.REGISTRAR_ROLE();
      const pauserRole = await registry.PAUSER_ROLE();

      expect(await registry.hasRole(adminRole, owner.address)).to.be.true;
      expect(await registry.hasRole(registrarRole, owner.address)).to.be.true;
      expect(await registry.hasRole(pauserRole, owner.address)).to.be.true;
    });

    it("Should allow admin to grant roles", async function () {
      const { registry, owner, registrar } = await loadFixture(deployRegistryFixture);

      const registrarRole = await registry.REGISTRAR_ROLE();

      await expect(
        registry.grantRole(registrarRole, registrar.address)
      ).to.emit(registry, "RoleGranted");

      expect(await registry.hasRole(registrarRole, registrar.address)).to.be.true;
    });

    it("Should allow pausing by pauser role", async function () {
      const { registry, owner } = await loadFixture(deployRegistryFixture);

      await expect(registry.pause()).to.emit(registry, "Paused");
      expect(await registry.paused()).to.be.true;

      await expect(registry.unpause()).to.emit(registry, "Unpaused");
      expect(await registry.paused()).to.be.false;
    });

    it("Should prevent operations when paused", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      await registry.pause();

      const price = await registry.priceOf("alice");

      await expect(
        registry.register(
          "alice",
          owner.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Availability", function () {
    it("Should correctly report domain availability", async function () {
      const { registry, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("available"))]));

      expect(await registry.isAvailable(node)).to.be.true;
    });

    it("Should report registered domain as unavailable", async function () {
      const { registry, node } = await loadFixture(registerDomainFixture);

      expect(await registry.isAvailable(node)).to.be.false;
    });

    it("Should report expired domain as available after grace period", async function () {
      const { registry, node } = await loadFixture(registerDomainFixture);

      // Fast forward past expiry and grace period
      await time.increase(oneYear + gracePeriod + 1);

      expect(await registry.isAvailable(node)).to.be.true;
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to set base fee", async function () {
      const { registry, owner } = await loadFixture(deployRegistryFixture);

      const newFee = ethers.parseEther("0.02");
      await registry.setBaseFee(newFee);

      expect(await registry.baseFee()).to.equal(newFee);
    });

    it("Should allow admin to set length premium", async function () {
      const { registry, owner } = await loadFixture(deployRegistryFixture);

      const newPremium = ethers.parseEther("2");
      await registry.setLengthPremium(1, newPremium);

      expect(await registry.lengthPremium(1)).to.equal(newPremium);
    });

    it("Should allow admin to withdraw funds", async function () {
      const { registry, resolver, owner, user1, TLD_NODE } = await loadFixture(deployRegistryFixture);

      // Register a domain to add funds
      const price = await registry.priceOf("alice");
      await registry.connect(user1).register(
        "alice",
        user1.address,
        oneYear,
        await resolver.getAddress(),
        TLD_NODE,
        { value: price }
      );

      const initialBalance = await ethers.provider.getBalance(owner.address);
      
      await expect(registry.withdraw()).to.not.be.reverted;
      
      const finalBalance = await ethers.provider.getBalance(owner.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should prevent non-admin from admin functions", async function () {
      const { registry, user1 } = await loadFixture(deployRegistryFixture);

      await expect(
        registry.connect(user1).setBaseFee(ethers.parseEther("0.02"))
      ).to.be.revertedWith("AccessControl:");

      await expect(
        registry.connect(user1).withdraw()
      ).to.be.revertedWith("AccessControl:");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero value registrations for free domains", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      // Set custom price to 0
      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("free"))]));
      
      await registry.setCustomPrice(node, 0);

      await expect(
        registry.register(
          "free",
          owner.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: 0 }
        )
      ).to.not.be.reverted;
    });

    it("Should handle maximum length domain names", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const maxName = "a".repeat(63); // Max length
      const price = await registry.priceOf(maxName);

      await expect(
        registry.register(
          maxName,
          owner.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.not.be.reverted;
    });

    it("Should handle minimum duration registrations", async function () {
      const { registry, resolver, owner, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const minDuration = 28 * 24 * 60 * 60; // 28 days
      const price = await registry.priceOf("alice");

      await expect(
        registry.register(
          "alice",
          owner.address,
          minDuration,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.not.be.reverted;
    });
  });

  describe("Events", function () {
    it("Should emit DomainRegistered with correct parameters", async function () {
      const { registry, resolver, user1, TLD_NODE } = await loadFixture(deployRegistryFixture);

      const price = await registry.priceOf("alice");
      const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"], 
        [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))]));

      await expect(
        registry.connect(user1).register(
          "alice",
          user1.address,
          oneYear,
          await resolver.getAddress(),
          TLD_NODE,
          { value: price }
        )
      ).to.emit(registry, "DomainRegistered")
       .withArgs(node, "alice", user1.address, await time.latest() + oneYear, price);
    });

    it("Should emit ResolverChanged when resolver is updated", async function () {
      const { registry, user1, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        registry.connect(user1).setResolver(node, user2.address)
      ).to.emit(registry, "ResolverChanged")
       .withArgs(node, user2.address);
    });
  });
});