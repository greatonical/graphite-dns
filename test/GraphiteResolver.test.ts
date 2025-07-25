// test/GraphiteResolver.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { GraphiteDNSRegistry, GraphiteResolver } from "../typechain-types";

describe("GraphiteResolver", function () {
  const ZERO_ADDRESS = ethers.ZeroAddress;
  const oneYear = 365 * 24 * 60 * 60;

  async function deployResolverFixture() {
    const [owner, user1, user2, user3, operator] = await ethers.getSigners();

    // Deploy registry first
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    const registry = await RegistryFactory.deploy(ZERO_ADDRESS, "atgraphite");

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const resolver = await ResolverFactory.deploy(await registry.getAddress());

    const TLD_NODE = await registry.TLD_NODE();

    return {
      registry,
      resolver,
      owner,
      user1,
      user2,
      user3,
      operator,
      TLD_NODE
    };
  }

  async function registerDomainFixture() {
    const base = await loadFixture(deployResolverFixture);
    const { registry, resolver, user1, TLD_NODE } = base;

    // Grant registrar role to owner for testing
    const registrarRole = await registry.REGISTRAR_ROLE();
    await registry.grantRole(registrarRole, base.owner.address);

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

    // Set resolver owner
    await resolver.setOwner(node, user1.address);

    return { ...base, node };
  }

  describe("Deployment", function () {
    it("Should deploy with correct registry reference", async function () {
      const { resolver, registry } = await loadFixture(deployResolverFixture);

      expect(await resolver.registry()).to.equal(await registry.getAddress());
    });

    it("Should grant admin role to deployer", async function () {
      const { resolver, owner } = await loadFixture(deployResolverFixture);

      expect(await resolver.hasRole(await resolver.DEFAULT_ADMIN_ROLE(), owner.address)).to.be.true;
    });
  });

  describe("Ownership Management", function () {
    it("Should allow registry to set owner", async function () {
      const { resolver, registry, user1, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(registry).setOwner(node, user1.address)
      ).to.emit(resolver, "OwnerChanged")
       .withArgs(node, user1.address);

      expect(await resolver.owner(node)).to.equal(user1.address);
    });

    it("Should allow current owner to change ownership", async function () {
      const { resolver, user1, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setOwner(node, user2.address)
      ).to.emit(resolver, "OwnerChanged")
       .withArgs(node, user2.address);

      expect(await resolver.owner(node)).to.equal(user2.address);
    });

    it("Should prevent unauthorized ownership changes", async function () {
      const { resolver, user2, user3, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user2).setOwner(node, user3.address)
      ).to.be.revertedWith("Not authorized");
    });

    it("Should fallback to registry owner when resolver owner not set", async function () {
      const { resolver, registry, user1, node } = await loadFixture(registerDomainFixture);

      // Deploy new resolver without setting owner
      const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
      const newResolver = await ResolverFactory.deploy(await registry.getAddress());

      expect(await newResolver.owner(node)).to.equal(user1.address); // Should fallback to registry
    });
  });

  describe("Operator Management", function () {
    it("Should allow owner to set operators", async function () {
      const { resolver, user1, operator, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setOperator(node, operator.address, true)
      ).to.emit(resolver, "OperatorChanged")
       .withArgs(node, operator.address, true);

      expect(await resolver.isOperator(node, operator.address)).to.be.true;
    });

    it("Should allow owner to revoke operators", async function () {
      const { resolver, user1, operator, node } = await loadFixture(registerDomainFixture);

      // First set operator
      await resolver.connect(user1).setOperator(node, operator.address, true);

      // Then revoke
      await expect(
        resolver.connect(user1).setOperator(node, operator.address, false)
      ).to.emit(resolver, "OperatorChanged")
       .withArgs(node, operator.address, false);

      expect(await resolver.isOperator(node, operator.address)).to.be.false;
    });

    it("Should prevent non-owner from setting operators", async function () {
      const { resolver, user2, operator, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user2).setOperator(node, operator.address, true)
      ).to.be.revertedWith("Not node owner");
    });
  });

  describe("Text Records", function () {
    it("Should allow owner to set text records", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setText(node, "email", "alice@example.com")
      ).to.emit(resolver, "TextChanged")
       .withArgs(node, "email", "alice@example.com");

      expect(await resolver.text(node, "email")).to.equal("alice@example.com");
    });

    it("Should allow operator to set text records", async function () {
      const { resolver, user1, operator, node } = await loadFixture(registerDomainFixture);

      // Set operator
      await resolver.connect(user1).setOperator(node, operator.address, true);

      // Operator sets text record
      await expect(
        resolver.connect(operator).setText(node, "url", "https://alice.com")
      ).to.emit(resolver, "TextChanged")
       .withArgs(node, "url", "https://alice.com");

      expect(await resolver.text(node, "url")).to.equal("https://alice.com");
    });

    it("Should prevent unauthorized text record modification", async function () {
      const { resolver, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user2).setText(node, "email", "hacker@evil.com")
      ).to.be.revertedWith("Not authorized");
    });

    it("Should allow deleting text records", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      // Set record first
      await resolver.connect(user1).setText(node, "email", "alice@example.com");
      expect(await resolver.text(node, "email")).to.equal("alice@example.com");

      // Delete record
      await expect(
        resolver.connect(user1).deleteText(node, "email")
      ).to.emit(resolver, "TextDeleted")
       .withArgs(node, "email");

      expect(await resolver.text(node, "email")).to.equal("");
    });

    it("Should support batch text record operations", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const keys = ["email", "url", "avatar"];
      const values = ["alice@example.com", "https://alice.com", "ipfs://Qm..."];

      await expect(
        resolver.connect(user1).setMultipleTexts(node, keys, values)
      ).to.emit(resolver, "TextChanged"); // Will emit multiple events

      expect(await resolver.text(node, "email")).to.equal("alice@example.com");
      expect(await resolver.text(node, "url")).to.equal("https://alice.com");
      expect(await resolver.text(node, "avatar")).to.equal("ipfs://Qm...");
    });

    it("Should handle empty values as deletions in batch operations", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      // Set some records first
      await resolver.connect(user1).setText(node, "email", "alice@example.com");
      await resolver.connect(user1).setText(node, "url", "https://alice.com");

      // Batch update with empty value (delete)
      const keys = ["email", "url"];
      const values = ["", "https://newalice.com"]; // Empty email = delete

      await resolver.connect(user1).setMultipleTexts(node, keys, values);

      expect(await resolver.text(node, "email")).to.equal(""); // Deleted
      expect(await resolver.text(node, "url")).to.equal("https://newalice.com"); // Updated
    });
  });

  describe("Address Records", function () {
    it("Should allow setting Ethereum addresses", async function () {
      const { resolver, user1, user2, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setAddr(node, user2.address)
      ).to.emit(resolver, "AddressChanged")
       .withArgs(node, user2.address);

      expect(await resolver.addr(node)).to.equal(user2.address);
    });

    it("Should support multi-coin addresses", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const btcAddress = "0x1234567890123456789012345678901234567890123456789012345678901234";
      const coinType = 0; // Bitcoin

      await expect(
        resolver.connect(user1).setAddrByType(node, coinType, btcAddress)
      ).to.emit(resolver, "AddressChangedByType")
       .withArgs(node, coinType, btcAddress);

      expect(await resolver.addrByType(node, coinType)).to.equal(btcAddress);
    });

    it("Should handle multiple coin types independently", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const btcAddr = "0x1234567890123456789012345678901234567890123456789012345678901234";
      const ethAddr = "0x9876543210987654321098765432109876543210987654321098765432109876";

      await resolver.connect(user1).setAddrByType(node, 0, btcAddr); // Bitcoin
      await resolver.connect(user1).setAddrByType(node, 60, ethAddr); // Ethereum

      expect(await resolver.addrByType(node, 0)).to.equal(btcAddr);
      expect(await resolver.addrByType(node, 60)).to.equal(ethAddr);
    });
  });

  describe("Content Hash Records", function () {
    it("Should allow setting content hash", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const contentHash = ethers.randomBytes(32);

      await expect(
        resolver.connect(user1).setContenthash(node, contentHash)
      ).to.emit(resolver, "ContenthashChanged")
       .withArgs(node, contentHash);

      const storedHash = await resolver.contenthash(node);
      expect(storedHash).to.equal(ethers.keccak256(contentHash));
    });
  });

  describe("Name Records", function () {
    it("Should allow setting canonical name", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setName(node, "alice.atgraphite")
      ).to.emit(resolver, "NameChanged")
       .withArgs(node, "alice.atgraphite");

      expect(await resolver.name(node)).to.equal("alice.atgraphite");
    });
  });

  describe("Public Key Records", function () {
    it("Should allow setting public keys", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const x = ethers.randomBytes(32);
      const y = ethers.randomBytes(32);

      await expect(
        resolver.connect(user1).setPubkey(node, x, y)
      ).to.emit(resolver, "PubkeyChanged")
       .withArgs(node, x, y);

      const [storedX, storedY] = await resolver.pubkey(node);
      expect(storedX).to.equal(x);
      expect(storedY).to.equal(y);
    });
  });

  describe("ABI Records", function () {
    it("Should allow setting ABI records", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const contentType = 1;
      const abiData = ethers.toUtf8Bytes('{"abi": "data"}');

      await expect(
        resolver.connect(user1).setABI(node, contentType, abiData)
      ).to.emit(resolver, "ABIChanged")
       .withArgs(node, contentType);

      const [returnedType, returnedData] = await resolver.ABI(node, contentType);
      expect(returnedType).to.equal(contentType);
      expect(returnedData).to.equal(abiData);
    });
  });

  describe("Interface Records", function () {
    it("Should allow setting interface implementers", async function () {
      const { resolver, user1, user2, node } = await loadFixture(registerDomainFixture);

      const interfaceId = "0x01ffc9a7"; // ERC165

      await expect(
        resolver.connect(user1).setInterface(node, interfaceId, user2.address)
      ).to.emit(resolver, "InterfaceChanged")
       .withArgs(node, interfaceId, user2.address);

      expect(await resolver.interfaceImplementer(node, interfaceId)).to.equal(user2.address);
    });
  });

  describe("Record Versioning", function () {
    it("Should increment version on record changes", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const initialVersion = await resolver.recordVersions(node);

      await resolver.connect(user1).setText(node, "email", "alice@example.com");

      const newVersion = await resolver.recordVersions(node);
      expect(newVersion).to.equal(initialVersion + 1n);
    });

    it("Should emit version change events", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      await expect(
        resolver.connect(user1).setText(node, "email", "alice@example.com")
      ).to.emit(resolver, "VersionChanged");
    });
  });

  describe("Batch Operations", function () {
    it("Should support multicall for batch operations", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      // Encode multiple calls
      const calls = [
        resolver.interface.encodeFunctionData("setText", [node, "email", "alice@example.com"]),
        resolver.interface.encodeFunctionData("setText", [node, "url", "https://alice.com"]),
        resolver.interface.encodeFunctionData("setAddr", [node, user1.address])
      ];

      await expect(resolver.connect(user1).multicall(calls)).to.not.be.reverted;

      expect(await resolver.text(node, "email")).to.equal("alice@example.com");
      expect(await resolver.text(node, "url")).to.equal("https://alice.com");
      expect(await resolver.addr(node)).to.equal(user1.address);
    });
  });

  describe("Clear Records", function () {
    it("Should allow clearing all records", async function () {
      const { resolver, user1, user2, node } = await loadFixture(registerDomainFixture);

      // Set various records
      await resolver.connect(user1).setText(node, "email", "alice@example.com");
      await resolver.connect(user1).setAddr(node, user2.address);
      await resolver.connect(user1).setName(node, "alice.atgraphite");

      // Clear all records
      await resolver.connect(user1).clearRecords(node);

      // Verify records are cleared
      expect(await resolver.text(node, "email")).to.equal("");
      expect(await resolver.addr(node)).to.equal(ZERO_ADDRESS);
      expect(await resolver.name(node)).to.equal("");
    });
  });

  describe("Node Validation", function () {
    it("Should prevent operations on non-existent nodes", async function () {
      const { resolver, user1 } = await loadFixture(deployResolverFixture);

      const fakeNode = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));

      await expect(
        resolver.connect(user1).setText(fakeNode, "email", "test@example.com")
      ).to.be.revertedWith("Node does not exist");
    });

    it("Should prevent operations on expired nodes", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      // Fast forward past expiry
      await time.increase(oneYear + 1);

      await expect(
        resolver.connect(user1).setText(node, "email", "test@example.com")
      ).to.be.revertedWith("Node expired");
    });
  });

  describe("Access Control", function () {
    it("Should allow admin emergency access", async function () {
      const { resolver, owner, node } = await loadFixture(registerDomainFixture);

      // Admin should be able to set records in emergency
      await expect(
        resolver.connect(owner).setText(node, "emergency", "admin-access")
      ).to.not.be.reverted;

      expect(await resolver.text(node, "emergency")).to.equal("admin-access");
    });

    it("Should allow pausing by admin", async function () {
      const { resolver, owner } = await loadFixture(deployResolverFixture);

      await expect(resolver.pause()).to.emit(resolver, "Paused");
      expect(await resolver.paused()).to.be.true;
    });

    it("Should prevent operations when paused", async function () {
      const { resolver, owner, user1, node } = await loadFixture(registerDomainFixture);

      await resolver.pause();

      await expect(
        resolver.connect(user1).setText(node, "test", "value")
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty string values", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      await resolver.connect(user1).setText(node, "empty", "");
      expect(await resolver.text(node, "empty")).to.equal("");
    });

    it("Should handle very long text records", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const longText = "a".repeat(1000);
      await resolver.connect(user1).setText(node, "long", longText);
      expect(await resolver.text(node, "long")).to.equal(longText);
    });

    it("Should handle zero addresses", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      await resolver.connect(user1).setAddr(node, ZERO_ADDRESS);
      expect(await resolver.addr(node)).to.equal(ZERO_ADDRESS);
    });

    it("Should handle batch operations with mismatched array lengths", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const keys = ["email", "url"];
      const values = ["alice@example.com"]; // One less value

      await expect(
        resolver.connect(user1).setMultipleTexts(node, keys, values)
      ).to.be.revertedWith("Array length mismatch");
    });
  });

  describe("Gas Optimization", function () {
    it("Should be gas efficient for single record operations", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const tx = await resolver.connect(user1).setText(node, "email", "alice@example.com");
      const receipt = await tx.wait();

      expect(receipt!.gasUsed).to.be.lt(100000); // Should be reasonably efficient
    });

    it("Should be more efficient for batch operations", async function () {
      const { resolver, user1, node } = await loadFixture(registerDomainFixture);

      const keys = ["email", "url", "avatar", "description"];
      const values = [
        "alice@example.com",
        "https://alice.com", 
        "ipfs://Qm...",
        "Alice's domain"
      ];

      const batchTx = await resolver.connect(user1).setMultipleTexts(node, keys, values);
      const batchReceipt = await batchTx.wait();

      // Should be more efficient than 4 individual calls
      expect(batchReceipt!.gasUsed).to.be.lt(300000);
    });
  });

  describe("Interface Support", function () {
    it("Should support ERC165 interface detection", async function () {
      const { resolver } = await loadFixture(deployResolverFixture);

      expect(await resolver.supportsInterface("0x01ffc9a7")).to.be.true; // ERC165
    });
  });
});