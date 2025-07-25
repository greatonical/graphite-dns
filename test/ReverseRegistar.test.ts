// test/ReverseRegistrar.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { GraphiteDNSRegistry, ReverseRegistrar } from "../typechain-types";

describe("ReverseRegistrar", function () {
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const oneYear = 365 * 24 * 60 * 60;

  async function deployReverseFixture() {
    const [owner, user1, user2, user3, registry] = await ethers.getSigners();

    // Deploy actual registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const actualRegistry = await RegistryFactory.deploy(ZERO_ADDRESS, "atgraphite");

    // Deploy reverse registrar
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    const reverse = await ReverseFactory.deploy(await actualRegistry.getAddress());

    // Setup roles
    const registryRole = await reverse.REGISTRY_ROLE();
    const managerRole = await reverse.MANAGER_ROLE();
    
    await reverse.grantRole(registryRole, await actualRegistry.getAddress());
    await reverse.grantRole(managerRole, owner.address);

    return {
      registry: actualRegistry,
      reverse,
      owner,
      user1,
      user2,
      user3,
      registryRole,
      managerRole
    };
  }

  async function registeredDomainFixture() {
    const base = await loadFixture(deployReverseFixture);
    const { registry, reverse, user1 } = base;

    // Grant registrar role to owner for testing
    const registrarRole = await registry.REGISTRAR_ROLE();
    await registry.grantRole(registrarRole, base.owner.address);

    // Register a domain
    const TLD_NODE = await registry.TLD_NODE();
    const price = await registry.priceOf("alice");
    await registry.register(
      "alice",
      user1.address,
      oneYear,
      ZERO_ADDRESS,
      TLD_NODE,
      { value: price }
    );

    const node = ethers.keccak256(ethers.solidityPacked(["bytes32", "bytes32"],
      [TLD_NODE, ethers.keccak256(ethers.toUtf8Bytes("alice"))]));

    // Set up reverse registrar integration
    await registry.setReverseRegistrar(await reverse.getAddress());
    const registryRole = await reverse.REGISTRY_ROLE();
    await reverse.grantRole(registryRole, await registry.getAddress());

    return { ...base, node, TLD_NODE };
  }

  describe("Deployment", function () {
    it("Should deploy with correct registry reference", async function () {
      const { reverse, registry } = await loadFixture(deployReverseFixture);

      expect(await reverse.registry()).to.equal(await registry.getAddress());
    });

    it("Should set default settings", async function () {
      const { reverse } = await loadFixture(deployReverseFixture);

      expect(await reverse.requireOwnership()).to.be.true;
      expect(await reverse.autoManagement()).to.be.true;
    });

    it("Should grant correct initial roles", async function () {
      const { reverse, owner, registry } = await loadFixture(deployReverseFixture);

      const adminRole = await reverse.DEFAULT_ADMIN_ROLE();
      const managerRole = await reverse.MANAGER_ROLE();
      const registryRole = await reverse.REGISTRY_ROLE();

      expect(await reverse.hasRole(adminRole, owner.address)).to.be.true;
      expect(await reverse.hasRole(managerRole, owner.address)).to.be.true;
      expect(await reverse.hasRole(registryRole, await registry.getAddress())).to.be.true;
    });
  });

  describe("Manual Reverse Record Management", function () {
    it("Should allow user to set reverse record", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      // Disable ownership requirement for this test
      await reverse.setOwnershipRequirement(false);

      await expect(
        reverse.connect(user1).setName("alice.atgraphite")
      ).to.emit(reverse, "NameSet")
       .withArgs(user1.address, "alice.atgraphite");

      expect(await reverse.name(user1.address)).to.equal("alice.atgraphite");
    });

    it("Should allow user to clear reverse record", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      await reverse.setOwnershipRequirement(false);
      await reverse.connect(user1).setName("alice.atgraphite");

      await expect(
        reverse.connect(user1).clearName()
      ).to.emit(reverse, "NameCleared")
       .withArgs(user1.address);

      expect(await reverse.name(user1.address)).to.equal("");
    });

    it("Should validate name length", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      await reverse.setOwnershipRequirement(false);

      // Empty name
      await expect(
        reverse.connect(user1).setName("")
      ).to.be.revertedWith("Empty name");

      // Too long name
      const longName = "a".repeat(256);
      await expect(
        reverse.connect(user1).setName(longName)
      ).to.be.revertedWith("Name too long");
    });

    it("Should enforce ownership when required", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      // Ownership requirement is true by default
      await expect(
        reverse.connect(user1).setName("unowned.atgraphite")
      ).to.be.revertedWith("Not name owner");
    });

    it("Should allow setting reverse record when user owns domain", async function () {
      const { reverse, user1 } = await loadFixture(registeredDomainFixture);

      await expect(
        reverse.connect(user1).setName("alice.atgraphite")
      ).to.emit(reverse, "NameSet")
       .withArgs(user1.address, "alice.atgraphite");
    });
  });

  describe("Automatic Reverse Record Management", function () {
    it("Should allow registry to set reverse record", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(registry).setNameForAddr(user1.address, "alice.atgraphite")
      ).to.emit(reverse, "NameSet")
       .withArgs(user1.address, "alice.atgraphite");

      expect(await reverse.name(user1.address)).to.equal("alice.atgraphite");
    });

    it("Should allow registry to clear reverse record", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      // Set record first
      await reverse.connect(registry).setNameForAddr(user1.address, "alice.atgraphite");

      // Clear record
      await expect(
        reverse.connect(registry).clearNameForAddr(user1.address)
      ).to.emit(reverse, "NameCleared")
       .withArgs(user1.address);

      expect(await reverse.name(user1.address)).to.equal("");
    });

    it("Should prevent non-registry from auto-setting", async function () {
      const { reverse, user1, user2 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(user1).setNameForAddr(user2.address, "hack.atgraphite")
      ).to.be.revertedWith("AccessControl:");
    });

    it("Should support batch operations", async function () {
      const { reverse, registry, user1, user2 } = await loadFixture(deployReverseFixture);

      const addresses = [user1.address, user2.address];
      const names = ["alice.atgraphite", "bob.atgraphite"];

      await expect(
        reverse.connect(registry).setMultipleNames(addresses, names)
      ).to.not.be.reverted;

      expect(await reverse.name(user1.address)).to.equal("alice.atgraphite");
      expect(await reverse.name(user2.address)).to.equal("bob.atgraphite");
    });

    it("Should handle empty names in batch operations as clears", async function () {
      const { reverse, registry, user1, user2 } = await loadFixture(deployReverseFixture);

      // Set some names first
      await reverse.connect(registry).setNameForAddr(user1.address, "alice.atgraphite");
      await reverse.connect(registry).setNameForAddr(user2.address, "bob.atgraphite");

      // Batch update with empty name (clear)
      const addresses = [user1.address, user2.address];
      const names = ["", "bobby.atgraphite"]; // Empty = clear

      await reverse.connect(registry).setMultipleNames(addresses, names);

      expect(await reverse.name(user1.address)).to.equal(""); // Cleared
      expect(await reverse.name(user2.address)).to.equal("bobby.atgraphite"); // Updated
    });

    it("Should validate batch operation array lengths", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const addresses = [user1.address];
      const names = ["alice.atgraphite", "extra.atgraphite"]; // Mismatched length

      await expect(
        reverse.connect(registry).setMultipleNames(addresses, names)
      ).to.be.revertedWith("Array length mismatch");
    });
  });

  describe("Ownership Tracking", function () {
    it("Should track owned names", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(registry).addOwnedName(user1.address, "alice.atgraphite")
      ).to.emit(reverse, "NameAdded")
       .withArgs(user1.address, "alice.atgraphite");

      expect(await reverse.ownsName(user1.address, "alice.atgraphite")).to.be.true;
      
      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames).to.include("alice.atgraphite");
    });

    it("Should remove owned names", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      // Add name first
      await reverse.connect(registry).addOwnedName(user1.address, "alice.atgraphite");

      // Remove name
      await expect(
        reverse.connect(registry).removeOwnedName(user1.address, "alice.atgraphite")
      ).to.emit(reverse, "NameRemoved")
       .withArgs(user1.address, "alice.atgraphite");

      expect(await reverse.ownsName(user1.address, "alice.atgraphite")).to.be.false;
      
      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames).to.not.include("alice.atgraphite");
    });

    it("Should clear reverse record when removing primary name", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      // Set as primary reverse record
      await reverse.connect(registry).setNameForAddr(user1.address, "alice.atgraphite");
      await reverse.connect(registry).addOwnedName(user1.address, "alice.atgraphite");

      // Remove the name
      await reverse.connect(registry).removeOwnedName(user1.address, "alice.atgraphite");

      // Primary reverse record should be cleared
      expect(await reverse.name(user1.address)).to.equal("");
    });

    it("Should track multiple owned names", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const names = ["alice.atgraphite", "alice2.atgraphite", "alice3.atgraphite"];

      for (const name of names) {
        await reverse.connect(registry).addOwnedName(user1.address, name);
      }

      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames.length).to.equal(3);
      for (const name of names) {
        expect(ownedNames).to.include(name);
      }

      expect(await reverse.nameCount(user1.address)).to.equal(3);
    });

    it("Should prevent duplicate name additions", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await reverse.connect(registry).addOwnedName(user1.address, "alice.atgraphite");

      // Adding same name again should not emit event or change state
      const tx = await reverse.connect(registry).addOwnedName(user1.address, "alice.atgraphite");
      const receipt = await tx.wait();
      
      // Should not emit NameAdded event again
      const events = receipt!.logs.filter(log => {
        try {
          return reverse.interface.parseLog(log)?.name === "NameAdded";
        } catch {
          return false;
        }
      });
      expect(events.length).to.equal(0);
    });
  });

  describe("Administrative Management", function () {
    it("Should allow manager to set names", async function () {
      const { reverse, owner, user1 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(owner).adminSetName(user1.address, "admin.atgraphite")
      ).to.emit(reverse, "NameSet")
       .withArgs(user1.address, "admin.atgraphite");

      expect(await reverse.name(user1.address)).to.equal("admin.atgraphite");
    });

    it("Should allow manager to clear names", async function () {
      const { reverse, owner, user1 } = await loadFixture(deployReverseFixture);

      await reverse.connect(owner).adminSetName(user1.address, "admin.atgraphite");

      await expect(
        reverse.connect(owner).adminClearName(user1.address)
      ).to.emit(reverse, "NameCleared")
       .withArgs(user1.address);

      expect(await reverse.name(user1.address)).to.equal("");
    });

    it("Should prevent non-manager from admin functions", async function () {
      const { reverse, user1, user2 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(user1).adminSetName(user2.address, "unauthorized.atgraphite")
      ).to.be.revertedWith("AccessControl:");

      await expect(
        reverse.connect(user1).adminClearName(user2.address)
      ).to.be.revertedWith("AccessControl:");
    });
  });

  describe("Settings Management", function () {
    it("Should allow admin to change ownership requirement", async function () {
      const { reverse, owner } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.setOwnershipRequirement(false)
      ).to.emit(reverse, "OwnershipRequirementChanged")
       .withArgs(false);

      expect(await reverse.requireOwnership()).to.be.false;
    });

    it("Should allow admin to change auto-management setting", async function () {
      const { reverse, owner } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.setAutoManagement(false)
      ).to.emit(reverse, "AutoManagementChanged")
       .withArgs(false);

      expect(await reverse.autoManagement()).to.be.false;
    });

    it("Should prevent non-admin from changing settings", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(user1).setOwnershipRequirement(false)
      ).to.be.revertedWith("AccessControl:");

      await expect(
        reverse.connect(user1).setAutoManagement(false)
      ).to.be.revertedWith("AccessControl:");
    });
  });

  describe("Validation Functions", function () {
    it("Should validate reverse claims correctly", async function () {
      const { reverse, user1 } = await loadFixture(registeredDomainFixture);

      // Valid claim (user owns the domain)
      let [valid, reason] = await reverse.validateReverseClaim(user1.address, "alice.atgraphite");
      expect(valid).to.be.true;
      expect(reason).to.equal("");

      // Invalid claim (user doesn't own domain)
      [valid, reason] = await reverse.validateReverseClaim(user1.address, "notowned.atgraphite");
      expect(valid).to.be.false;
      expect(reason).to.equal("Not name owner");
    });

    it("Should handle non-existent domains in validation", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      const [valid, reason] = await reverse.validateReverseClaim(user1.address, "nonexistent.atgraphite");
      expect(valid).to.be.false;
      expect(reason).to.equal("Name does not exist");
    });

    it("Should bypass validation when ownership not required", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      await reverse.setOwnershipRequirement(false);

      const [valid, reason] = await reverse.validateReverseClaim(user1.address, "anything.atgraphite");
      expect(valid).to.be.true;
      expect(reason).to.equal("");
    });
  });

  describe("Auto-Management Behavior", function () {
    it("Should auto-add names when auto-management is enabled", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      expect(await reverse.autoManagement()).to.be.true;

      // When registry sets name, should auto-add to owned names
      await reverse.connect(registry).setNameForAddr(user1.address, "auto.atgraphite");

      expect(await reverse.ownsName(user1.address, "auto.atgraphite")).to.be.true;
      expect(await reverse.getNameOwner("auto.atgraphite")).to.equal(user1.address);
    });

    it("Should not auto-add names when auto-management is disabled", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await reverse.setAutoManagement(false);

      await reverse.connect(registry).setNameForAddr(user1.address, "manual.atgraphite");

      // Should not be automatically added to owned names
      expect(await reverse.ownsName(user1.address, "manual.atgraphite")).to.be.false;
    });

    it("Should clear old name mapping when setting new name", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      // Set first name
      await reverse.connect(registry).setNameForAddr(user1.address, "first.atgraphite");
      expect(await reverse.getNameOwner("first.atgraphite")).to.equal(user1.address);

      // Set second name (should clear first mapping)
      await reverse.connect(registry).setNameForAddr(user1.address, "second.atgraphite");
      expect(await reverse.getNameOwner("first.atgraphite")).to.equal(ZERO_ADDRESS);
      expect(await reverse.getNameOwner("second.atgraphite")).to.equal(user1.address);
    });
  });

  describe("View Functions", function () {
    it("Should return correct name for address", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await reverse.connect(registry).setNameForAddr(user1.address, "test.atgraphite");
      expect(await reverse.name(user1.address)).to.equal("test.atgraphite");
    });

    it("Should return empty string for address with no name", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      expect(await reverse.name(user1.address)).to.equal("");
    });

    it("Should return correct owned names list", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const names = ["alice.atgraphite", "bob.atgraphite"];
      for (const name of names) {
        await reverse.connect(registry).addOwnedName(user1.address, name);
      }

      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames.length).to.equal(2);
      expect(ownedNames).to.include("alice.atgraphite");
      expect(ownedNames).to.include("bob.atgraphite");
    });

    it("Should return correct name count", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      expect(await reverse.nameCount(user1.address)).to.equal(0);

      await reverse.connect(registry).addOwnedName(user1.address, "first.atgraphite");
      expect(await reverse.nameCount(user1.address)).to.equal(1);

      await reverse.connect(registry).addOwnedName(user1.address, "second.atgraphite");
      expect(await reverse.nameCount(user1.address)).to.equal(2);
    });

    it("Should return correct name owner", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      await reverse.connect(registry).addOwnedName(user1.address, "owned.atgraphite");
      expect(await reverse.getNameOwner("owned.atgraphite")).to.equal(user1.address);

      expect(await reverse.getNameOwner("unowned.atgraphite")).to.equal(ZERO_ADDRESS);
    });

    it("Should correctly report if address has name", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      expect(await reverse.hasName(user1.address)).to.be.false;

      await reverse.connect(registry).setNameForAddr(user1.address, "test.atgraphite");
      expect(await reverse.hasName(user1.address)).to.be.true;
    });
  });

  describe("Access Control", function () {
    it("Should allow admin to pause contract", async function () {
      const { reverse, owner } = await loadFixture(deployReverseFixture);

      await expect(reverse.pause()).to.emit(reverse, "Paused");
      expect(await reverse.paused()).to.be.true;
    });

    it("Should prevent operations when paused", async function () {
      const { reverse, owner, user1 } = await loadFixture(deployReverseFixture);

      await reverse.pause();

      await expect(
        reverse.connect(user1).setName("paused.atgraphite")
      ).to.be.revertedWith("Pausable: paused");
    });

    it("Should allow unpausing", async function () {
      const { reverse, owner } = await loadFixture(deployReverseFixture);

      await reverse.pause();
      await expect(reverse.unpause()).to.emit(reverse, "Unpaused");
      expect(await reverse.paused()).to.be.false;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle maximum length names", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const maxName = "a".repeat(255);
      await expect(
        reverse.connect(registry).setNameForAddr(user1.address, maxName)
      ).to.not.be.reverted;

      expect(await reverse.name(user1.address)).to.equal(maxName);
    });

    it("Should handle special characters in names", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const specialName = "test-domain.sub.atgraphite";
      await reverse.connect(registry).setNameForAddr(user1.address, specialName);
      expect(await reverse.name(user1.address)).to.equal(specialName);
    });

    it("Should handle removing non-existent owned name", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      // Try to remove name that was never added
      await expect(
        reverse.connect(registry).removeOwnedName(user1.address, "never-added.atgraphite")
      ).to.not.be.reverted;

      // Should not emit any events
      const tx = await reverse.connect(registry).removeOwnedName(user1.address, "never-added.atgraphite");
      const receipt = await tx.wait();
      
      const events = receipt!.logs.filter(log => {
        try {
          return reverse.interface.parseLog(log)?.name === "NameRemoved";
        } catch {
          return false;
        }
      });
      expect(events.length).to.equal(0);
    });

    it("Should handle clearing name when no name is set", async function () {
      const { reverse, user1 } = await loadFixture(deployReverseFixture);

      await expect(
        reverse.connect(user1).clearName()
      ).to.emit(reverse, "NameCleared")
       .withArgs(user1.address);

      expect(await reverse.name(user1.address)).to.equal("");
    });
  });

  describe("Gas Optimization", function () {
    it("Should be gas efficient for single name operations", async function () {
      const { reverse, registry, user1 } = await loadFixture(deployReverseFixture);

      const tx = await reverse.connect(registry).setNameForAddr(user1.address, "gas-test.atgraphite");
      const receipt = await tx.wait();

      expect(receipt!.gasUsed).to.be.lt(100000);
    });

    it("Should be efficient for batch operations", async function () {
      const { reverse, registry, user1, user2, user3 } = await loadFixture(deployReverseFixture);

      const addresses = [user1.address, user2.address, user3.address];
      const names = ["batch1.atgraphite", "batch2.atgraphite", "batch3.atgraphite"];

      const tx = await reverse.connect(registry).setMultipleNames(addresses, names);
      const receipt = await tx.wait();

      // Should be more efficient than 3 individual calls
      expect(receipt!.gasUsed).to.be.lt(250000);
    });
  });

  describe("Integration Tests", function () {
    it("Should integrate properly with registry for automatic management", async function () {
      const { registry, reverse, user1, TLD_NODE } = await loadFixture(registeredDomainFixture);

      // Registry should have automatically set reverse record
      expect(await reverse.name(user1.address)).to.equal("alice.atgraphite");

      // Should track ownership
      expect(await reverse.ownsName(user1.address, "alice.atgraphite")).to.be.true;
    });

    it("Should handle domain transfers with reverse record updates", async function () {
      const { registry, reverse, user1, user2, node } = await loadFixture(registeredDomainFixture);

      // Transfer domain
      const tokenId = 2; // Second token (first is TLD)
      await registry.connect(user1).transferFrom(user1.address, user2.address, tokenId);

      // Reverse records should be updated
      expect(await reverse.name(user1.address)).to.equal("");
      expect(await reverse.name(user2.address)).to.equal("alice.atgraphite");
    });
  });
});