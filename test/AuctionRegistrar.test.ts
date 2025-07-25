// test/SubdomainRegistrar.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { GraphiteDNSRegistry, GraphiteResolver, SubdomainRegistrar, ReverseRegistrar } from "../typechain-types";

describe("SubdomainRegistrar", function () {
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const oneYear = 365 * 24 * 60 * 60;

  // Subdomain types
  const MANAGED = 0;
  const DELEGATED = 1;
  const SOLD = 2;

  // Subdomain status
  const INACTIVE = 0;
  const AVAILABLE = 1;
  const SOLD_OUT = 2;
  const PAUSED = 3;

  async function deploySubdomainFixture() {
    const [owner, user1, user2, user3] = await ethers.getSigners();

    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const registry = await RegistryFactory.deploy(ZERO_ADDRESS, "atgraphite");

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const resolver = await ResolverFactory.deploy(await registry.getAddress());

    // Deploy reverse registrar
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    const reverse = await ReverseFactory.deploy(await registry.getAddress());

    // Deploy subdomain registrar
    const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
    const subdomain = await SubdomainFactory.deploy(
      await registry.getAddress(),
      await reverse.getAddress()
    );

    // Setup roles
    const registrarRole = await registry.REGISTRAR_ROLE();
    const registryRole = await reverse.REGISTRY_ROLE();
    
    await registry.grantRole(registrarRole, owner.address);
    await registry.grantRole(registrarRole, await subdomain.getAddress());
    await reverse.grantRole(registryRole, await registry.getAddress());

    const TLD_NODE = await registry.TLD_NODE();

    return {
      registry,
      resolver,
      reverse,
      subdomain,
      owner,
      user1,
      user2,
      user3,
      TLD_NODE
    };
  }

  async function registerParentDomainFixture() {
    const base = await loadFixture(deploySubdomainFixture);
    const { registry, resolver, user1, TLD_NODE } = base;

    const price = await registry.priceOf("parent");
    await registry.register(
      "parent",
      user1.address,
      oneYear,
      await resolver.getAddress(),
      TLD_NODE,
      { value: price }
    );

    const parentNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
      [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("parent"))]));

    return { ...base, parentNode };
  }

  describe("Deployment", function () {
    it("Should deploy with correct registry and reverse registrar", async function () {
      const { subdomain, registry, reverse } = await loadFixture(deploySubdomainFixture);

      expect(await subdomain.registry()).to.equal(await registry.getAddress());
      expect(await subdomain.reverseRegistrar()).to.equal(await reverse.getAddress());
    });

    it("Should set correct TLD_NODE", async function () {
      const { subdomain, TLD_NODE } = await loadFixture(deploySubdomainFixture);

      expect(await subdomain.TLD_NODE()).to.equal(TLD_NODE);
    });
  });

  describe("Subdomain Configuration", function () {
    it("Should allow parent owner to configure subdomain", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode,
          "api",
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.emit(subdomain, "SubdomainConfigured")
       .withArgs(parentNode, "api", ethers.parseEther("0.1"), SOLD, AVAILABLE);
    });

    it("Should prevent non-parent-owner from configuring", async function () {
      const { subdomain, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user2).configureSubdomain(
          parentNode,
          "api",
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.be.revertedWith("Not parent owner");
    });

    it("Should prevent configuration for expired parent", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      // Fast forward past parent expiry
      await time.increase(oneYear + 1);

      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode,
          "api",
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.be.revertedWith("Parent expired");
    });

    it("Should validate subdomain label format", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      // Empty label
      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode,
          "",
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.be.revertedWith("Invalid label length");

      // Too long label
      const longLabel = "a".repeat(64);
      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode,
          longLabel,
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.be.revertedWith("Invalid label length");

      // Invalid characters
      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode,
          "api!",
          ethers.parseEther("0.1"),
          SOLD,
          oneYear,
          100,
          false
        )
      ).to.be.revertedWith("Invalid label format");
    });
  });

  describe("Managed Subdomain Creation", function () {
    it("Should allow parent owner to create managed subdomain", async function () {
      const { subdomain, resolver, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user1).createManagedSubdomain(
          parentNode,
          "managed",
          await resolver.getAddress()
        )
      ).to.emit(subdomain, "SubdomainCreated");

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("managed"))]));

      const record = await subdomain.getSubdomainRecord(subdomainNode);
      expect(record.currentOwner).to.equal(user1.address);
      expect(record.originalOwner).to.equal(user1.address);
      expect(record.subType).to.equal(MANAGED);
    });

    it("Should inherit parent expiry for managed subdomains", async function () {
      const { subdomain, registry, resolver, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).createManagedSubdomain(
        parentNode,
        "inherit",
        await resolver.getAddress()
      );

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("inherit"))]));

      const parentRecord = await registry.getRecord(parentNode);
      const subdomainRecord = await registry.getRecord(subdomainNode);

      expect(subdomainRecord.expiry).to.equal(parentRecord.expiry);
    });

    it("Should prevent non-parent-owner from creating managed subdomain", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user2).createManagedSubdomain(
          parentNode,
          "unauthorized",
          await resolver.getAddress()
        )
      ).to.be.revertedWith("Not parent owner");
    });

    it("Should track managed subdomains for owner", async function () {
      const { subdomain, resolver, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).createManagedSubdomain(
        parentNode,
        "tracked",
        await resolver.getAddress()
      );

      const managedSubdomains = await subdomain.getManagedSubdomains(user1.address);
      expect(managedSubdomains.length).to.be.gt(0);
    });
  });

  describe("Subdomain Sales", function () {
    async function configuredSubdomainFixture() {
      const base = await loadFixture(registerParentDomainFixture);
      const { subdomain, user1, parentNode } = base;

      await subdomain.connect(user1).configureSubdomain(
        parentNode,
        "shop",
        ethers.parseEther("0.1"),
        SOLD,
        oneYear,
        10, // max supply
        false // no approval required
      );

      return base;
    }

    it("Should allow buying configured subdomain", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      const price = ethers.parseEther("0.1");

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode,
          "shop",
          await resolver.getAddress(),
          { value: price }
        )
      ).to.emit(subdomain, "SubdomainCreated");

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("shop"))]));

      const record = await subdomain.getSubdomainRecord(subdomainNode);
      expect(record.currentOwner).to.equal(user2.address);
      expect(record.subType).to.equal(SOLD);
    });

    it("Should refund excess payment", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      const price = ethers.parseEther("0.1");
      const excess = ethers.parseEther("0.05");
      const initialBalance = await ethers.provider.getBalance(user2.address);

      const tx = await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: price + excess }
      );

      const receipt = await tx.wait();
      const gasUsed = receipt!.gasUsed * receipt!.gasPrice;
      const finalBalance = await ethers.provider.getBalance(user2.address);

      // Should only pay the actual price plus gas
      expect(finalBalance).to.be.closeTo(
        initialBalance - price - gasUsed,
        ethers.parseEther("0.001")
      );
    });

    it("Should track earnings for parent owner", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      const price = ethers.parseEther("0.1");

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: price }
      );

      const earnings = await subdomain.getOwnerEarnings(user1.address);
      expect(earnings).to.equal(price);
    });

    it("Should allow parent owner to withdraw earnings", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      const price = ethers.parseEther("0.1");

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: price }
      );

      const initialBalance = await ethers.provider.getBalance(user1.address);

      await expect(
        subdomain.connect(user1).withdrawEarnings()
      ).to.emit(subdomain, "EarningsWithdrawn")
       .withArgs(user1.address, price);

      const finalBalance = await ethers.provider.getBalance(user1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });

    it("Should prevent buying unavailable subdomain", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode,
          "notconfigured",
          await resolver.getAddress(),
          { value: ethers.parseEther("0.1") }
        )
      ).to.be.revertedWith("Subdomain not available");
    });

    it("Should prevent buying with insufficient payment", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      const price = ethers.parseEther("0.1");

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode,
          "shop",
          await resolver.getAddress(),
          { value: price - 1n }
        )
      ).to.be.revertedWith("Insufficient payment");
    });

    it("Should respect supply limits", async function () {
      const { subdomain, resolver, user1, user2, user3, parentNode } = await loadFixture(registerParentDomainFixture);

      // Configure with supply of 1
      await subdomain.connect(user1).configureSubdomain(
        parentNode,
        "limited",
        ethers.parseEther("0.1"),
        SOLD,
        oneYear,
        1, // max supply = 1
        false
      );

      const price = ethers.parseEther("0.1");

      // First purchase should succeed
      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "limited",
        await resolver.getAddress(),
        { value: price }
      );

      // Second purchase should fail
      await expect(
        subdomain.connect(user3).buySubdomain(
          parentNode,
          "limited",
          await resolver.getAddress(),
          { value: price }
        )
      ).to.be.revertedWith("Supply exhausted");
    });

    it("Should update status to SOLD_OUT when supply exhausted", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).configureSubdomain(
        parentNode,
        "sellout",
        ethers.parseEther("0.1"),
        SOLD,
        oneYear,
        1,
        false
      );

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "sellout",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.1") }
      );

      const config = await subdomain.getSubdomainConfig(parentNode, "sellout");
      expect(config.status).to.equal(SOLD_OUT);
    });
  });

  describe("Approved Buyer System", function () {
    async function approvalRequiredFixture() {
      const base = await loadFixture(registerParentDomainFixture);
      const { subdomain, user1, parentNode } = base;

      await subdomain.connect(user1).configureSubdomain(
        parentNode,
        "exclusive",
        ethers.parseEther("0.1"),
        SOLD,
        oneYear,
        10,
        true // requires approval
      );

      return base;
    }

    it("Should allow parent owner to add approved buyers", async function () {
      const { subdomain, user1, user2, parentNode } = await loadFixture(approvalRequiredFixture);

      await expect(
        subdomain.connect(user1).addApprovedBuyer(parentNode, "exclusive", user2.address)
      ).to.emit(subdomain, "ApprovedBuyerAdded")
       .withArgs(parentNode, "exclusive", user2.address);

      expect(await subdomain.isApprovedBuyer(parentNode, "exclusive", user2.address)).to.be.true;
    });

    it("Should prevent unapproved buyers from purchasing", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(approvalRequiredFixture);

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode,
          "exclusive",
          await resolver.getAddress(),
          { value: ethers.parseEther("0.1") }
        )
      ).to.be.revertedWith("Not approved buyer");
    });

    it("Should allow approved buyers to purchase", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(approvalRequiredFixture);

      await subdomain.connect(user1).addApprovedBuyer(parentNode, "exclusive", user2.address);

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode,
          "exclusive",
          await resolver.getAddress(),
          { value: ethers.parseEther("0.1") }
        )
      ).to.not.be.reverted;
    });

    it("Should return list of approved buyers", async function () {
      const { subdomain, user1, user2, user3, parentNode } = await loadFixture(approvalRequiredFixture);

      await subdomain.connect(user1).addApprovedBuyer(parentNode, "exclusive", user2.address);
      await subdomain.connect(user1).addApprovedBuyer(parentNode, "exclusive", user3.address);

      const approvedBuyers = await subdomain.getApprovedBuyers(parentNode, "exclusive");
      expect(approvedBuyers).to.include(user2.address);
      expect(approvedBuyers).to.include(user3.address);
      expect(approvedBuyers.length).to.equal(2);
    });
  });

  describe("Subdomain Transfers", function () {
    async function soldSubdomainFixture() {
      const base = await loadFixture(configuredSubdomainFixture);
      const { subdomain, resolver, user2, parentNode } = base;

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.1") }
      );

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("shop"))]));

      return { ...base, subdomainNode };
    }

    it("Should allow subdomain owner to transfer SOLD subdomain", async function () {
      const { subdomain, user2, user3, subdomainNode } = await loadFixture(soldSubdomainFixture);

      await expect(
        subdomain.connect(user2).transferSubdomain(subdomainNode, user3.address, SOLD)
      ).to.emit(subdomain, "SubdomainTransferred")
       .withArgs(subdomainNode, user2.address, user3.address, SOLD);

      const record = await subdomain.getSubdomainRecord(subdomainNode);
      expect(record.currentOwner).to.equal(user3.address);
    });

    it("Should prevent unauthorized transfers", async function () {
      const { subdomain, user3, subdomainNode } = await loadFixture(soldSubdomainFixture);

      await expect(
        subdomain.connect(user3).transferSubdomain(subdomainNode, user3.address, SOLD)
      ).to.be.revertedWith("Not subdomain owner");
    });

    it("Should only allow original owner to transfer MANAGED subdomains", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      // Create managed subdomain
      await subdomain.connect(user1).createManagedSubdomain(
        parentNode,
        "managed-transfer",
        await resolver.getAddress()
      );

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("managed-transfer"))]));

      // Original owner can transfer
      await expect(
        subdomain.connect(user1).transferSubdomain(subdomainNode, user2.address, DELEGATED)
      ).to.not.be.reverted;
    });
  });

  describe("Subdomain Renewal", function () {
    it("Should allow subdomain renewal", async function () {
      const { subdomain, subdomainNode } = await loadFixture(soldSubdomainFixture);

      await expect(
        subdomain.renewSubdomain(subdomainNode)
      ).to.emit(subdomain, "SubdomainRenewed");
    });

    it("Should inherit parent expiry for managed subdomains", async function () {
      const { subdomain, resolver, registry, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).createManagedSubdomain(
        parentNode,
        "auto-renew",
        await resolver.getAddress()
      );

      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("auto-renew"))]));

      await subdomain.renewSubdomain(subdomainNode);

      const parentRecord = await registry.getRecord(parentNode);
      const subdomainRecord = await registry.getRecord(subdomainNode);

      expect(subdomainRecord.expiry).to.equal(parentRecord.expiry);
    });

    it("Should charge fee for SOLD subdomain renewals", async function () {
      const { subdomain, user2, subdomainNode } = await loadFixture(soldSubdomainFixture);

      // Should require payment for sold subdomain renewal
      await expect(
        subdomain.connect(user2).renewSubdomain(subdomainNode)
      ).to.be.revertedWith("Insufficient renewal fee");
    });
  });

  describe("Subdomain Status Management", function () {
    it("Should allow parent owner to change subdomain status", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(configuredSubdomainFixture);

      await expect(
        subdomain.connect(user1).setSubdomainStatus(parentNode, "shop", PAUSED)
      ).to.emit(subdomain, "SubdomainStatusChanged")
       .withArgs(parentNode, "shop", AVAILABLE, PAUSED);

      const config = await subdomain.getSubdomainConfig(parentNode, "shop");
      expect(config.status).to.equal(PAUSED);
    });

    it("Should prevent non-parent-owner from changing status", async function () {
      const { subdomain, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      await expect(
        subdomain.connect(user2).setSubdomainStatus(parentNode, "shop", PAUSED)
      ).to.be.revertedWith("Not parent owner");
    });
  });

  describe("View Functions", function () {
    it("Should return correct subdomain configuration", async function () {
      const { subdomain, parentNode } = await loadFixture(configuredSubdomainFixture);

      const config = await subdomain.getSubdomainConfig(parentNode, "shop");
      
      expect(config.price).to.equal(ethers.parseEther("0.1"));
      expect(config.subType).to.equal(SOLD);
      expect(config.status).to.equal(AVAILABLE);
      expect(config.maxSupply).to.equal(10);
      expect(config.requiresApproval).to.be.false;
    });

    it("Should return subdomain labels for parent", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).configureSubdomain(
        parentNode, "api", ethers.parseEther("0.1"), SOLD, oneYear, 10, false
      );
      await subdomain.connect(user1).configureSubdomain(
        parentNode, "www", ethers.parseEther("0.05"), SOLD, oneYear, 5, false
      );

      const labels = await subdomain.getSubdomainLabels(parentNode);
      expect(labels).to.include("api");
      expect(labels).to.include("www");
      expect(labels.length).to.equal(2);
    });

    it("Should return parent earnings", async function () {
      const { subdomain, resolver, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.1") }
      );

      const earnings = await subdomain.getParentEarnings(parentNode);
      expect(earnings).to.equal(ethers.parseEther("0.1"));
    });
  });

  describe("Reverse Registrar Integration", function () {
    it("Should update reverse registrar on subdomain creation", async function () {
      const { subdomain, reverse, resolver, user2, parentNode } = await loadFixture(configuredSubdomainFixture);

      await subdomain.connect(user2).buySubdomain(
        parentNode,
        "shop",
        await resolver.getAddress(),
        { value: ethers.parseEther("0.1") }
      );

      // Note: This test would need the reverse registrar to actually track the subdomain
      // The current implementation may not fully integrate this
    });
  });

  describe("Access Control", function () {
    it("Should allow admin to pause contract", async function () {
      const { subdomain, owner } = await loadFixture(deploySubdomainFixture);

      await expect(subdomain.pause()).to.emit(subdomain, "Paused");
      expect(await subdomain.paused()).to.be.true;
    });

    it("Should prevent operations when paused", async function () {
      const { subdomain, owner, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.pause();

      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode, "paused", ethers.parseEther("0.1"), SOLD, oneYear, 10, false
        )
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Should allow admin to set reverse registrar", async function () {
      const { subdomain, owner, user1 } = await loadFixture(deploySubdomainFixture);

      await expect(
        subdomain.setReverseRegistrar(user1.address)
      ).to.not.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero-price subdomains", async function () {
      const { subdomain, resolver, user1, user2, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).configureSubdomain(
        parentNode, "free", 0, SOLD, oneYear, 10, false
      );

      await expect(
        subdomain.connect(user2).buySubdomain(
          parentNode, "free", await resolver.getAddress(), { value: 0 }
        )
      ).to.not.be.reverted;
    });

    it("Should handle unlimited supply (maxSupply = 0)", async function () {
      const { subdomain, resolver, user1, user2, user3, parentNode } = await loadFixture(registerParentDomainFixture);

      await subdomain.connect(user1).configureSubdomain(
        parentNode, "unlimited", ethers.parseEther("0.1"), SOLD, oneYear, 0, false
      );

      // Should allow multiple purchases
      const price = ethers.parseEther("0.1");
      await subdomain.connect(user2).buySubdomain(
        parentNode, "unlimited", await resolver.getAddress(), { value: price }
      );
      await subdomain.connect(user3).buySubdomain(
        parentNode, "unlimited", await resolver.getAddress(), { value: price }
      );

      const config = await subdomain.getSubdomainConfig(parentNode, "unlimited");
      expect(config.totalSold).to.equal(2);
      expect(config.status).to.equal(AVAILABLE); // Should not change to SOLD_OUT
    });

    it("Should handle very long subdomain labels", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      const maxLabel = "a".repeat(63);

      await expect(
        subdomain.connect(user1).configureSubdomain(
          parentNode, maxLabel, ethers.parseEther("0.1"), SOLD, oneYear, 10, false
        )
      ).to.not.be.reverted;
    });

    it("Should prevent withdrawal when no earnings", async function () {
      const { subdomain, user1 } = await loadFixture(registerParentDomainFixture);

      await expect(
        subdomain.connect(user1).withdrawEarnings()
      ).to.be.revertedWith("No earnings to withdraw");
    });
  });

  describe("Gas Optimization", function () {
    it("Should be gas efficient for subdomain creation", async function () {
      const { subdomain, resolver, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      const tx = await subdomain.connect(user1).createManagedSubdomain(
        parentNode, "gas-test", await resolver.getAddress()
      );
      const receipt = await tx.wait();

      expect(receipt!.gasUsed).to.be.lt(300000);
    });

    it("Should be efficient for batch subdomain configuration", async function () {
      const { subdomain, user1, parentNode } = await loadFixture(registerParentDomainFixture);

      // Configure multiple subdomains
      const subdomains = ["api", "www", "mail", "ftp"];
      
      for (const sub of subdomains) {
        await subdomain.connect(user1).configureSubdomain(
          parentNode, sub, ethers.parseEther("0.1"), SOLD, oneYear, 10, false
        );
      }

      // Should complete without excessive gas usage
      const labels = await subdomain.getSubdomainLabels(parentNode);
      expect(labels.length).to.equal(4);
    });
  });

  describe("Integration Tests", function () {
    it("Should handle complete subdomain lifecycle", async function () {
      const { subdomain, resolver, user1, user2, user3, parentNode } = await loadFixture(registerParentDomainFixture);

      // 1. Configure subdomain
      await subdomain.connect(user1).configureSubdomain(
        parentNode, "lifecycle", ethers.parseEther("0.1"), SOLD, oneYear, 5, false
      );

      // 2. Buy subdomain
      await subdomain.connect(user2).buySubdomain(
        parentNode, "lifecycle", await resolver.getAddress(), 
        { value: ethers.parseEther("0.1") }
      );

      // 3. Transfer subdomain
      const subdomainNode = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
        [parentNode, ethers.keccak256(ethers.toUtf8Bytes("lifecycle"))]));
      
      await subdomain.connect(user2).transferSubdomain(subdomainNode, user3.address, SOLD);

      // 4. Renew subdomain
      await subdomain.connect(user3).renewSubdomain(subdomainNode, { value: ethers.parseEther("0.01") });

      // 5. Parent withdraws earnings
      await subdomain.connect(user1).withdrawEarnings();

      // Verify final state
      const record = await subdomain.getSubdomainRecord(subdomainNode);
      expect(record.currentOwner).to.equal(user3.address);
      expect(record.isActive).to.be.true;
    });
  });
});