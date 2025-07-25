// test/ReverseRegistrar.test.ts
import { expect } from "chai";
import { ethers } from "hardhat";
import {
  GraphiteDNSRegistry,
  GraphiteResolver,
  ReverseRegistrar,
} from "../typechain";

describe("ReverseRegistrar", function () {
  let registry: GraphiteDNSRegistry;
  let resolver: GraphiteResolver;
  let reverseRegistrar: ReverseRegistrar;
  let user1: any;

  beforeEach(async () => {
    [, user1] = await ethers.getSigners();

    const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
    resolver = await ResolverFactory.deploy(ethers.ZeroAddress);

    const RegistryFactory = await ethers.getContractFactory(
      "GraphiteDNSRegistry"
    );
    registry = await RegistryFactory.deploy(await resolver.getAddress());

    resolver = await ResolverFactory.deploy(await registry.getAddress());

    const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
    reverseRegistrar = await ReverseFactory.deploy(await registry.getAddress());

    await registry.register(
      "test",
      user1.address,
      365 * 24 * 3600,
      await resolver.getAddress(),
      await registry.TLD_NODE()
    );
  });

  describe("Reverse Records", () => {
    it("Should set reverse records for owned domains", async () => {
      const node = ethers.keccak256(
        ethers.concat([
          await registry.TLD_NODE(),
          ethers.keccak256(ethers.toUtf8Bytes("test")),
        ])
      );
      await expect(
        reverseRegistrar.connect(user1).setReverseForNode(node)
      ).to.emit(reverseRegistrar, "ReverseSet");
      // await expect(
      //   reverseRegistrar.connect(user1).setReverse("test.atgraphite")
      // ).to.emit(reverseRegistrar, "ReverseSet");

      expect(await reverseRegistrar.getReverse(user1.address)).to.equal(
        "test.atgraphite"
      );
    });
  });
});
