import React from "react";
import { Composition } from "remotion";
import { HeroIntro } from "./scenes/HeroIntro";
import { FeatureShowcase } from "./scenes/FeatureShowcase";
import { CostComparison } from "./scenes/CostComparison";
import { sizes } from "./lib/tokens";

export const RemotionRoot: React.FC = () => {
  const fps = 30;

  return (
    <>
      {/* Reel 1: Hero Intro — 15 seconds, 9:16 vertical */}
      <Composition
        id="HeroIntro"
        component={HeroIntro}
        durationInFrames={450}
        fps={fps}
        width={sizes.reelWidth}
        height={sizes.reelHeight}
      />

      {/* Reel 2: Feature Showcase — 20 seconds, 9:16 vertical */}
      <Composition
        id="FeatureShowcase"
        component={FeatureShowcase}
        durationInFrames={600}
        fps={fps}
        width={sizes.reelWidth}
        height={sizes.reelHeight}
      />

      {/* Reel 3: Cost Comparison — 15 seconds, 9:16 vertical */}
      <Composition
        id="CostComparison"
        component={CostComparison}
        durationInFrames={450}
        fps={fps}
        width={sizes.reelWidth}
        height={sizes.reelHeight}
      />

      {/* Landscape versions for YouTube / landing pages */}
      <Composition
        id="HeroIntro-Landscape"
        component={HeroIntro}
        durationInFrames={450}
        fps={fps}
        width={sizes.landscapeWidth}
        height={sizes.landscapeHeight}
      />

      <Composition
        id="FeatureShowcase-Landscape"
        component={FeatureShowcase}
        durationInFrames={600}
        fps={fps}
        width={sizes.landscapeWidth}
        height={sizes.landscapeHeight}
      />

      <Composition
        id="CostComparison-Landscape"
        component={CostComparison}
        durationInFrames={450}
        fps={fps}
        width={sizes.landscapeWidth}
        height={sizes.landscapeHeight}
      />
    </>
  );
};
