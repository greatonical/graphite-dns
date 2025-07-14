import { expect } from "chai";
import { ethers } from "hardhat";
import type { GraphiteDNSRegistry, GraphiteResolver, ReverseRegistrar } from "../typechain";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("ReverseRegistrar - Fixed Version", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let reverse: ReverseRegistrar;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let unauthorized: SignerWithAddress;

  const oneYear = 365 * 24 * 3600;

  beforeEach(async function () {
    [owner, user1, user2, unauthorized] = await ethers.getSigners();

    // Deploy resolver
    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
    
    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
    registry = await RegistryFactory.deploy(await tempResolver.getAddress());
    
    // Deploy final resolver
    resolver = await ResolverFactory.deploy(await registry.getAddress());
    
    // Deploy reverse registrar
    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    reverse = await ReverseFactory.deploy(await registry.getAddress());

    // Register some test domains
    const price1 = await registry["priceOf(string,uint64)"]("user1domain", oneYear);
    await registry.connect(user1).buyFixedPrice(
      "user1domain",
      await resolver.getAddress(),
      oneYear,
      { value: price1 }
    );

    const price2 = await registry["priceOf(string,uint64)"]("user1second", oneYear);
    await registry.connect(user1).buyFixedPrice(
      "user1second",
      await resolver.getAddress(),
      oneYear,
      { value: price2 }
    );

    const price3 = await registry["priceOf(string,uint64)"]("user2domain", oneYear);
    await registry.connect(user2).buyFixedPrice(
      "user2domain",
      await resolver.getAddress(),
      oneYear,
      { value: price3 }
    );
  });

  describe("Primary Name Management", function () {
    it("Should allow domain owner to set primary name", async function () {
      await expect(
        reverse.connect(user1).setPrimaryName("user1domain")
      ).to.emit(reverse, "PrimaryNameSet")
       .withArgs(user1.address, "user1domain")
       .and.to.emit(reverse, "NameAdded")
       .withArgs(user1.address, "user1domain");

      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");
    });

    it("Should reject setting primary name for non-owned domain", async function () {
      await expect(
        reverse.connect(user1).setPrimaryName("user2domain")
      ).to.be.revertedWith("Not domain owner");
    });

    it("Should reject setting primary name for non-existent domain", async function () {
      await expect(
        reverse.connect(user1).setPrimaryName("nonexistent")
      ).to.be.revertedWith("Domain not found");
    });

    it("Should reject setting primary name for expired domain", async function () {
      // Fast forward past domain expiry
      await ethers.provider.send("evm_increaseTime", [oneYear + 1]);
      await ethers.provider.send("evm_mine", []);

      await expect(
        reverse.connect(user1).setPrimaryName("user1domain")
      ).to.be.revertedWith("Domain expired");
    });

    it("Should allow clearing primary name", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");

      await expect(
        reverse.connect(user1).clearPrimaryName()
      ).to.emit(reverse, "PrimaryNameSet")
       .withArgs(user1.address, "");

      expect(await reverse.getPrimaryName(user1.address)).to.equal("");
    });

    it("Should update primary name when switching between owned domains", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");

      await reverse.connect(user1).setPrimaryName("user1second");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1second");
    });

    it("Should support legacy getReverse function", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getReverse(user1.address)).to.equal("user1domain");
    });
  });

  describe("Owned Names Management", function () {
    it("Should automatically add domain to owned list when setting primary", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      
      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames).to.include("user1domain");
      expect(await reverse.getOwnedNameCount(user1.address)).to.equal(1);
      expect(await reverse.ownsNameInReverse(user1.address, "user1domain")).to.be.true;
    });

    it("Should allow manually adding owned names", async function () {
      await expect(
        reverse.connect(user1).addOwnedName("user1domain")
      ).to.emit(reverse, "NameAdded")
       .withArgs(user1.address, "user1domain");

      expect(await reverse.ownsNameInReverse(user1.address, "user1domain")).to.be.true;
    });

    it("Should prevent adding non-owned domains", async function () {
      await expect(
        reverse.connect(user1).addOwnedName("user2domain")
      ).to.be.revertedWith("Not domain owner");
    });

    it("Should prevent adding already added domains", async function () {
      await reverse.connect(user1).addOwnedName("user1domain");
      
      await expect(
        reverse.connect(user1).addOwnedName("user1domain")
      ).to.be.revertedWith("Already added");
    });

    it("Should allow removing owned names", async function () {
      await reverse.connect(user1).addOwnedName("user1domain");
      await reverse.connect(user1).addOwnedName("user1second");
      
      expect(await reverse.getOwnedNameCount(user1.address)).to.equal(2);

      await expect(
        reverse.connect(user1).removeOwnedName("user1domain")
      ).to.emit(reverse, "NameRemoved")
       .withArgs(user1.address, "user1domain");

      expect(await reverse.getOwnedNameCount(user1.address)).to.equal(1);
      expect(await reverse.ownsNameInReverse(user1.address, "user1domain")).to.be.false;
      expect(await reverse.ownsNameInReverse(user1.address, "user1second")).to.be.true;
    });

    it("Should clear primary name when removing it from owned list", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");

      await expect(
        reverse.connect(user1).removeOwnedName("user1domain")
      ).to.emit(reverse, "PrimaryNameSet")
       .withArgs(user1.address, "");

      expect(await reverse.getPrimaryName(user1.address)).to.equal("");
    });

    it("Should not affect primary name when removing non-primary owned name", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      await reverse.connect(user1).addOwnedName("user1second");

      await reverse.connect(user1).removeOwnedName("user1second");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");
    });

    it("Should get all owned names", async function () {
      await reverse.connect(user1).addOwnedName("user1domain");
      await reverse.connect(user1).addOwnedName("user1second");

      const ownedNames = await reverse.getOwnedNames(user1.address);
      expect(ownedNames).to.have.lengthOf(2);
      expect(ownedNames).to.include("user1domain");
      expect(ownedNames).to.include("user1second");
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to set reverse for any address", async function () {
      const reverseRole = await reverse.REVERSE_ROLE();
      await reverse.grantRole(reverseRole, owner.address);

      await expect(
        reverse.setReverseFor(user1.address, "user1domain")
      ).to.emit(reverse, "PrimaryNameSet")
       .withArgs(user1.address, "user1domain");

      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");
    });

    it("Should validate domain exists when admin sets reverse", async function () {
      const reverseRole = await reverse.REVERSE_ROLE();
      await reverse.grantRole(reverseRole, owner.address);

      // Should work with existing domain
      await reverse.setReverseFor(user1.address, "user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");

      // Should allow empty name
      await reverse.setReverseFor(user1.address, "");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("");
    });

    it("Should reject admin functions from unauthorized users", async function () {
      await expect(
        reverse.connect(unauthorized).setReverseFor(user1.address, "user1domain")
      ).to.be.reverted;
    });

    it("Should support legacy setReverse admin function", async function () {
      const reverseRole = await reverse.REVERSE_ROLE();
      await reverse.grantRole(reverseRole, owner.address);

      await reverse.setReverse("user1domain");
      expect(await reverse.getPrimaryName(owner.address)).to.equal("user1domain");
    });
  });

  describe("Sync Functionality", function () {
    it("Should sync owned names with registry state", async function () {
      // Add names to reverse registrar
      await reverse.connect(user1).addOwnedName("user1domain");
      await reverse.connect(user1).addOwnedName("user1second");
      await reverse.connect(user1).setPrimaryName("user1domain");

      // Transfer one domain to another user
      const tokenId = await registry.getTokenOfNode(
        await registry.getNodeOfLabel("user1domain")
      );
      await registry.connect(user1).transferFrom(
        user1.address,
        user2.address,
        tokenId
      );

      // Sync should remove transferred domain
      await reverse.syncOwnedNames(user1.address);

      expect(await reverse.ownsNameInReverse(user1.address, "user1domain")).to.be.false;
      expect(await reverse.ownsNameInReverse(user1.address, "user1second")).to.be.true;
      expect(await reverse.getPrimaryName(user1.address)).to.equal(""); // Should clear primary
    });

    it("Should handle expired domains in sync", async function () {
      await reverse.connect(user1).addOwnedName("user1domain");
      await reverse.connect(user1).setPrimaryName("user1domain");

      // Fast forward past expiry
      await ethers.provider.send("evm_increaseTime", [oneYear + 1]);
      await ethers.provider.send("evm_mine", []);

      await reverse.syncOwnedNames(user1.address);

      expect(await reverse.ownsNameInReverse(user1.address, "user1domain")).to.be.false;
      expect(await reverse.getPrimaryName(user1.address)).to.equal("");
    });

    it("Should allow anyone to call sync for any address", async function () {
      await reverse.connect(user1).addOwnedName("user1domain");

      // unauthorized user should be able to call sync
      await reverse.connect(unauthorized).syncOwnedNames(user1.address);
    });
  });

  describe("Multi-User Scenarios", function () {
    it("Should handle multiple users with different domains", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      await reverse.connect(user2).setPrimaryName("user2domain");

      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");
      expect(await reverse.getPrimaryName(user2.address)).to.equal("user2domain");

      const user1Names = await reverse.getOwnedNames(user1.address);
      const user2Names = await reverse.getOwnedNames(user2.address);

      expect(user1Names).to.include("user1domain");
      expect(user2Names).to.include("user2domain");
      expect(user1Names).to.not.include("user2domain");
      expect(user2Names).to.not.include("user1domain");
    });

    it("Should handle domain transfers between users", async function () {
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");

      // Transfer domain
      const tokenId = await registry.getTokenOfNode(
        await registry.getNodeOfLabel("user1domain")
      );
      await registry.connect(user1).transferFrom(
        user1.address,
        user2.address,
        tokenId
      );

      // user2 should now be able to set it as primary
      await reverse.connect(user2).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user2.address)).to.equal("user1domain");

      // user1 should no longer be able to set it
      await expect(
        reverse.connect(user1).setPrimaryName("user1domain")
      ).to.be.revertedWith("Not domain owner");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle empty strings gracefully", async function () {
      expect(await reverse.getPrimaryName(unauthorized.address)).to.equal("");
      expect(await reverse.getOwnedNames(unauthorized.address)).to.have.lengthOf(0);
      expect(await reverse.getOwnedNameCount(unauthorized.address)).to.equal(0);
    });

    it("Should handle addresses with no domains", async function () {
      expect(await reverse.ownsNameInReverse(unauthorized.address, "user1domain")).to.be.false;
      
      const ownedNames = await reverse.getOwnedNames(unauthorized.address);
      expect(ownedNames).to.have.lengthOf(0);
    });

    it("Should handle very long domain names", async function () {
      // Register a domain with maximum length name
      const longName = "a".repeat(32); // MAX_NAME_LENGTH
      const price = await registry["priceOf(string,uint64)"](longName, oneYear);
      await registry.connect(user1).buyFixedPrice(
        longName,
        await resolver.getAddress(),
        oneYear,
        { value: price }
      );

      await reverse.connect(user1).setPrimaryName(longName);
      expect(await reverse.getPrimaryName(user1.address)).to.equal(longName);
    });

    it("Should prevent setting primary name with empty string", async function () {
      await expect(
        reverse.connect(user1).setPrimaryName("")
      ).to.be.revertedWith("Empty name");
    });
  });

  describe("Pausing Functionality", function () {
    it("Should allow pausing and unpausing", async function () {
      await reverse.pause();
      expect(await reverse.paused()).to.be.true;

      await expect(
        reverse.connect(user1).setPrimaryName("user1domain")
      ).to.be.revertedWith("Pausable: paused");

      await reverse.unpause();
      expect(await reverse.paused()).to.be.false;

      // Should work after unpausing
      await reverse.connect(user1).setPrimaryName("user1domain");
      expect(await reverse.getPrimaryName(user1.address)).to.equal("user1domain");
    });

    it("Should restrict pause functions to admin", async function () {
      await expect(
        reverse.connect(unauthorized).pause()
      ).to.be.reverted;

      await expect(
        reverse.connect(unauthorized).unpause()
      ).to.be.reverted;
    });
  });

  describe("Gas Optimization", function () {
    it("Should efficiently handle multiple domain management", async function () {
      // Add multiple domains
      await reverse.connect(user1).addOwnedName("user1domain");
      await reverse.connect(user1).addOwnedName("user1second");
      
      const tx = await reverse.connect(user1).setPrimaryName("user1domain");
      const receipt = await tx.wait();
      
      // Should be reasonably efficient
      expect(receipt!.gasUsed).to.be.lt(ethers.parseUnits("100000", "wei"));
    });
  });
});