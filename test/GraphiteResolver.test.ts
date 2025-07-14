import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GraphiteResolver - Fixed Version", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let owner: SignerWithAddress;
  let domainOwner: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  const oneYear = 365 * 24 * 3600;
  let domainNode: string;

  beforeEach(async function () {
    [owner, domainOwner, unauthorized] = await ethers.getSigners();

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await tempResolver.getAddress());
    
    // Deploy final resolver
    resolver = await ResolverFactory.deploy(await registry.getAddress());

    // Grant RESOLVER_ROLE to resolver contract
    const resolverRole = await registry.RESOLVER_ROLE();
    await registry.grantRole(resolverRole, await resolver.getAddress());

    // Register a test domain
    const price = await registry["priceOf(string,uint64)"]("testdomain", oneYear);
    await registry.connect(domainOwner).buyFixedPrice(
      "testdomain",
      await resolver.getAddress(),
      oneYear,
      { value: price }
    );

    domainNode = await registry.getNodeOfToken(1n);
  });

  describe("Access Control", function () {
    it("Should allow domain owner to set text records", async function () {
      await expect(
        resolver.connect(domainOwner).setText(domainNode, "email", "test@example.com")
      ).to.emit(resolver, "TextChanged")
       .withArgs(domainNode, "email", "test@example.com");

      expect(await resolver.text(domainNode, "email")).to.equal("test@example.com");
    });

    it("Should reject unauthorized users", async function () {
      await expect(
        resolver.connect(unauthorized).setText(domainNode, "email", "hack@example.com")
      ).to.be.revertedWith("Not authorized for this domain");
    });

    it("Should allow admin to set records", async function () {
      const resolverRole = await resolver.RESOLVER_ROLE();
      await resolver.grantRole(resolverRole, owner.address);

      await expect(
        resolver.connect(owner).setText(domainNode, "admin", "set by admin")
      ).to.emit(resolver, "TextChanged");
    });

    it("Should reject operations on expired domains", async function () {
      // Fast forward past domain expiry
      await ethers.provider.send("evm_increaseTime", [oneYear + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        resolver.connect(domainOwner).setText(domainNode, "expired", "should fail")
      ).to.be.revertedWith("Domain expired");
    });
  });

  describe("Text Records", function () {
    it("Should set and get text records", async function () {
      await resolver.connect(domainOwner).setText(domainNode, "description", "My awesome domain");
      expect(await resolver.text(domainNode, "description")).to.equal("My awesome domain");
    });

    it("Should handle multiple text records", async function () {
      await resolver.connect(domainOwner).setText(domainNode, "email", "user@example.com");
      await resolver.connect(domainOwner).setText(domainNode, "url", "https://example.com");
      await resolver.connect(domainOwner).setText(domainNode, "description", "Test domain");

      expect(await resolver.text(domainNode, "email")).to.equal("user@example.com");
      expect(await resolver.text(domainNode, "url")).to.equal("https://example.com");
      expect(await resolver.text(domainNode, "description")).to.equal("Test domain");
    });

    it("Should handle empty text records", async function () {
      expect(await resolver.text(domainNode, "nonexistent")).to.equal("");
    });

    it("Should allow clearing text records", async function () {
      await resolver.connect(domainOwner).setText(domainNode, "temp", "temporary value");
      expect(await resolver.text(domainNode, "temp")).to.equal("temporary value");

      await resolver.connect(domainOwner).clearText(domainNode, "temp");
      expect(await resolver.text(domainNode, "temp")).to.equal("");
    });

    it("Should support batch text record operations", async function () {
      const keys = ["email", "url", "description"];
      const values = ["user@example.com", "https://example.com", "Test domain"];

      const tx = await resolver.connect(domainOwner).setTextBatch(domainNode, keys, values);
      const receipt = await tx.wait();
      
      // Should emit TextChanged event for each key
      expect(receipt!.logs.length).to.be.greaterThanOrEqual(3);

      for (let i = 0; i < keys.length; i++) {
        expect(await resolver.text(domainNode, keys[i])).to.equal(values[i]);
      }
    });

    it("Should reject batch operations with mismatched arrays", async function () {
      const keys = ["email", "url"];
      const values = ["user@example.com"]; // Missing second value

      await expect(
        resolver.connect(domainOwner).setTextBatch(domainNode, keys, values)
      ).to.be.revertedWith("Array length mismatch");
    });

    it("Should support standard record keys", async function () {
      // Test standard keys are defined
      expect(await resolver.AVATAR_KEY()).to.equal("avatar");
      expect(await resolver.EMAIL_KEY()).to.equal("email");
      expect(await resolver.URL_KEY()).to.equal("url");
      expect(await resolver.DESCRIPTION_KEY()).to.equal("description");
    });
  });

  describe("Address Records", function () {
    it("Should set and get ETH address", async function () {
      await expect(
        resolver.connect(domainOwner).setAddr(domainNode, domainOwner.address)
      ).to.emit(resolver, "AddressChanged")
       .withArgs(domainNode, domainOwner.address);

      expect(await resolver.addr(domainNode)).to.equal(domainOwner.address);
    });

    it("Should handle zero address", async function () {
      await resolver.connect(domainOwner).setAddr(domainNode, ethers.ZeroAddress);
      expect(await resolver.addr(domainNode)).to.equal(ethers.ZeroAddress);
    });

    it("Should return zero address for unset records", async function () {
      expect(await resolver.addr(domainNode)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Interface Support", function () {
    it("Should set and get interface implementers", async function () {
      const interfaceId = "0x12345678";
      const implementer = unauthorized.address;

      await expect(
        resolver.connect(domainOwner).setInterface(domainNode, interfaceId, implementer)
      ).to.emit(resolver, "InterfaceChanged")
       .withArgs(domainNode, interfaceId, implementer);

      expect(await resolver.interfaceImplementer(domainNode, interfaceId)).to.equal(implementer);
    });

    it("Should handle multiple interfaces", async function () {
      const interface1 = "0x12345678";
      const interface2 = "0x87654321";
      const implementer1 = domainOwner.address;
      const implementer2 = unauthorized.address;

      await resolver.connect(domainOwner).setInterface(domainNode, interface1, implementer1);
      await resolver.connect(domainOwner).setInterface(domainNode, interface2, implementer2);

      expect(await resolver.interfaceImplementer(domainNode, interface1)).to.equal(implementer1);
      expect(await resolver.interfaceImplementer(domainNode, interface2)).to.equal(implementer2);
    });
  });

  describe("Profile Management", function () {
    it("Should set complete profile", async function () {
      const displayName = "Alice Smith";
      const description = "Blockchain developer";
      const avatar = "ipfs://QmHash";
      const url = "https://alice.example.com";
      const ethAddress = domainOwner.address;

      await resolver.connect(domainOwner).setProfile(
        domainNode,
        displayName,
        description,
        avatar,
        url,
        ethAddress
      );

      const profile = await resolver.getProfile(domainNode);
      expect(profile.displayName).to.equal(displayName);
      expect(profile.description).to.equal(description);
      expect(profile.avatar).to.equal(avatar);
      expect(profile.url).to.equal(url);
      expect(profile.ethAddress).to.equal(ethAddress);
    });

    it("Should handle partial profile updates", async function () {
      await resolver.connect(domainOwner).setProfile(
        domainNode,
        "Alice",
        "", // empty description
        "ipfs://avatar",
        "", // empty url
        ethers.ZeroAddress
      );

      const profile = await resolver.getProfile(domainNode);
      expect(profile.displayName).to.equal("Alice");
      expect(profile.description).to.equal("");
      expect(profile.avatar).to.equal("ipfs://avatar");
      expect(profile.url).to.equal("");
      expect(profile.ethAddress).to.equal(ethers.ZeroAddress);
    });

    it("Should allow profile updates", async function () {
      // Set initial profile
      await resolver.connect(domainOwner).setProfile(
        domainNode,
        "Alice",
        "Developer",
        "ipfs://avatar1",
        "https://alice.com",
        domainOwner.address
      );

      // Update profile
      await resolver.connect(domainOwner).setProfile(
        domainNode,
        "Alice Smith",
        "Senior Developer",
        "ipfs://avatar2",
        "https://alicesmith.com",
        unauthorized.address
      );

      const profile = await resolver.getProfile(domainNode);
      expect(profile.displayName).to.equal("Alice Smith");
      expect(profile.description).to.equal("Senior Developer");
      expect(profile.avatar).to.equal("ipfs://avatar2");
      expect(profile.url).to.equal("https://alicesmith.com");
      expect(profile.ethAddress).to.equal(unauthorized.address);
    });
  });

  describe("Record Cleanup", function () {
    beforeEach(async function () {
      // Set up some records
      await resolver.connect(domainOwner).setText(domainNode, "email", "test@example.com");
      await resolver.connect(domainOwner).setText(domainNode, "url", "https://example.com");
      await resolver.connect(domainOwner).setText(domainNode, "description", "Test domain");
      await resolver.connect(domainOwner).setAddr(domainNode, domainOwner.address);
    });

    it("Should clear all records", async function () {
      const textKeys = ["email", "url", "description"];
      
      await resolver.connect(domainOwner).clearAllRecords(domainNode, textKeys);

      // Check text records cleared
      for (const key of textKeys) {
        expect(await resolver.text(domainNode, key)).to.equal("");
      }

      // Check address record cleared
      expect(await resolver.addr(domainNode)).to.equal(ethers.ZeroAddress);
    });

    it("Should emit events when clearing records", async function () {
      const textKeys = ["email", "url"];
      
      await expect(
        resolver.connect(domainOwner).clearAllRecords(domainNode, textKeys)
      ).to.emit(resolver, "TextChanged")
       .and.to.emit(resolver, "AddressChanged");
    });

    it("Should handle empty text keys array", async function () {
      await resolver.connect(domainOwner).clearAllRecords(domainNode, []);
      
      // Text records should remain
      expect(await resolver.text(domainNode, "email")).to.equal("test@example.com");
      
      // Address should be cleared
      expect(await resolver.addr(domainNode)).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Pausing Functionality", function () {
    it("Should allow pausing and unpausing", async function () {
      await resolver.pause();
      expect(await resolver.paused()).to.be.true;

      await expect(
        resolver.connect(domainOwner).setText(domainNode, "test", "value")
      ).to.be.revertedWith("Pausable: paused");

      await resolver.unpause();
      expect(await resolver.paused()).to.be.false;

      // Should work after unpausing
      await resolver.connect(domainOwner).setText(domainNode, "test", "value");
      expect(await resolver.text(domainNode, "test")).to.equal("value");
    });

    it("Should restrict pause functions to admin", async function () {
      await expect(
        resolver.connect(unauthorized).pause()
      ).to.be.reverted;

      await expect(
        resolver.connect(unauthorized).unpause()
      ).to.be.reverted;
    });
  });

  describe("Edge Cases", function () {
    it("Should handle very long text values", async function () {
      const longText = "a".repeat(1000);
      
      await resolver.connect(domainOwner).setText(domainNode, "long", longText);
      expect(await resolver.text(domainNode, "long")).to.equal(longText);
    });

    it("Should handle special characters in text", async function () {
      const specialText = "Hello 世界! 🌍 Special chars: àáâãäå";
      
      await resolver.connect(domainOwner).setText(domainNode, "special", specialText);
      expect(await resolver.text(domainNode, "special")).to.equal(specialText);
    });

    it("Should handle empty string values", async function () {
      await resolver.connect(domainOwner).setText(domainNode, "empty", "");
      expect(await resolver.text(domainNode, "empty")).to.equal("");
    });

    it("Should handle records for non-existent domains", async function () {
      const fakeNode = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      
      await expect(
        resolver.connect(domainOwner).setText(fakeNode, "test", "value")
      ).to.be.revertedWith("Not authorized for this domain");
    });
  });

  describe("Gas Optimization", function () {
    it("Should efficiently handle batch operations", async function () {
      const keys = Array.from({length: 10}, (_, i) => `key${i}`);
      const values = Array.from({length: 10}, (_, i) => `value${i}`);

      const tx = await resolver.connect(domainOwner).setTextBatch(domainNode, keys, values);
      const receipt = await tx.wait();
      
      // Should be more efficient than individual calls
      expect(receipt!.gasUsed).to.be.lt(ethers.parseUnits("500000", "wei"));
    });

    it("Should handle large profile updates efficiently", async function () {
      const tx = await resolver.connect(domainOwner).setProfile(
        domainNode,
        "Very Long Display Name That Exceeds Normal Limits",
        "Very long description that contains a lot of text and should test the gas efficiency of the profile setting function when dealing with longer strings",
        "ipfs://QmVeryLongHashThatRepresentsAnAvatarImageStoredOnIPFS",
        "https://verylongdomainname.example.com/with/very/long/path/structure",
        domainOwner.address
      );
      
      const receipt = await tx.wait();
      expect(receipt!.gasUsed).to.be.lt(ethers.parseUnits("200000", "wei"));
    });
  });

  describe("Integration with Registry", function () {
    it("Should properly validate domain ownership through registry", async function () {
      // Transfer domain ownership via NFT
      const tokenId = await registry.getTokenOfNode(domainNode);
      await registry.connect(domainOwner).transferFrom(
        domainOwner.address,
        unauthorized.address,
        tokenId
      );

      // Original owner should no longer be able to set records
      await expect(
        resolver.connect(domainOwner).setText(domainNode, "test", "should fail")
      ).to.be.revertedWith("Not authorized for this domain");

      // New owner should be able to set records
      await resolver.connect(unauthorized).setText(domainNode, "test", "should work");
      expect(await resolver.text(domainNode, "test")).to.equal("should work");
    });

    it("Should handle registry address changes gracefully", async function () {
      // This tests that the resolver properly integrates with the registry
      const domain = await registry.getDomain(domainNode);
      expect(domain.owner).to.equal(domainOwner.address);
      
      // Should be able to set records
      await resolver.connect(domainOwner).setText(domainNode, "integration", "test");
      expect(await resolver.text(domainNode, "integration")).to.equal("test");
    });
  });
});