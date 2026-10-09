'use client';

import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TEAM_3D_PALETTES, TREE_SPECIES, TreeSpeciesArchetype } from '@/lib/tree3d';

interface ProceduralTree3DProps {
  teamNumber: number;
  vitality: number; // 0.0 -> 1.0
  windSpeed?: number;
  dewCount?: number;
  position?: [number, number, number];
}

export default function ProceduralTree3D({
  teamNumber,
  vitality,
  windSpeed = 1.0,
  dewCount = 0,
  position = [0, 0, 0]
}: ProceduralTree3DProps) {
  const groupRef = useRef<THREE.Group>(null);
  const trunkScaleGroupRef = useRef<THREE.Group>(null);
  const crownRef = useRef<THREE.Group>(null);
  const branchesRef = useRef<THREE.Group>(null);
  const godRayRef = useRef<THREE.Mesh>(null);
  const pollenGroupRef = useRef<THREE.Group>(null);
  const currentGrowthRef = useRef(0.12);

  const colors = TEAM_3D_PALETTES[teamNumber] || TEAM_3D_PALETTES[1];
  const speciesConfig = TREE_SPECIES[teamNumber] || TREE_SPECIES[1];
  const species: TreeSpeciesArchetype = speciesConfig.species;

  // Species-specific branch skeletons
  const oakBoughs = useMemo(() => [
    { angle: 0.25, tilt: 0.65, length: 1.55, scale: [1.3, 0.75, 1.2] as [number, number, number], elev: 0.35 },
    { angle: 2.25, tilt: 0.56, length: 1.40, scale: [1.15, 0.7, 1.1] as [number, number, number], elev: 0.25 },
    { angle: 4.40, tilt: 0.72, length: 1.65, scale: [1.35, 0.8, 1.25] as [number, number, number], elev: 0.40 }
  ], []);

  const banyanBoughs = useMemo(() => [
    { angle: 0.40, tilt: 0.52, length: 1.50, scale: [1.45, 0.55, 1.4] as [number, number, number], elev: 0.2 },
    { angle: 1.85, tilt: 0.48, length: 1.40, scale: [1.35, 0.5, 1.3] as [number, number, number], elev: 0.25 },
    { angle: 3.45, tilt: 0.54, length: 1.55, scale: [1.4, 0.52, 1.35] as [number, number, number], elev: 0.18 },
    { angle: 4.95, tilt: 0.50, length: 1.35, scale: [1.3, 0.48, 1.25] as [number, number, number], elev: 0.28 }
  ], []);

  const pineTiers = useMemo(() => [
    // Bottom wide tier
    { angle: 0, tilt: 0.82, length: 1.35, scale: [1.3, 0.55, 1.3] as [number, number, number], yPos: 1.2 },
    { angle: (Math.PI * 2) / 3, tilt: 0.82, length: 1.35, scale: [1.3, 0.55, 1.3] as [number, number, number], yPos: 1.2 },
    { angle: (Math.PI * 4) / 3, tilt: 0.82, length: 1.35, scale: [1.3, 0.55, 1.3] as [number, number, number], yPos: 1.2 },
    // Mid compact tier
    { angle: Math.PI / 3, tilt: 0.78, length: 0.95, scale: [1.0, 0.5, 1.0] as [number, number, number], yPos: 1.65 },
    { angle: Math.PI, tilt: 0.78, length: 0.95, scale: [1.0, 0.5, 1.0] as [number, number, number], yPos: 1.65 },
    { angle: (Math.PI * 5) / 3, tilt: 0.78, length: 0.95, scale: [1.0, 0.5, 1.0] as [number, number, number], yPos: 1.65 }
  ], []);

  const sakuraBoughs = useMemo(() => [
    { angle: 0.15, tilt: 0.70, length: 1.60, scale: [1.2, 0.65, 1.1] as [number, number, number], dip: -0.15 },
    { angle: (Math.PI * 2) / 3 + 0.1, tilt: 0.66, length: 1.50, scale: [1.15, 0.6, 1.05] as [number, number, number], dip: -0.12 },
    { angle: (Math.PI * 4) / 3 - 0.1, tilt: 0.74, length: 1.65, scale: [1.25, 0.7, 1.15] as [number, number, number], dip: -0.18 }
  ], []);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const time = state.clock.elapsedTime;

    // Smooth lerp growth
    const target = Math.max(0.08, vitality);
    currentGrowthRef.current += (target - currentGrowthRef.current) * Math.min(1, delta * 3.2);
    const g = currentGrowthRef.current;

    // Gentle organic wind sway (species-tuned stiffness)
    const stiffness = species === 'pine' ? 0.65 : species === 'sakura' ? 1.35 : 1.0;
    const sway = Math.sin(time * 1.5 * windSpeed + teamNumber * 1.3) * 0.028 * windSpeed * stiffness;
    groupRef.current.rotation.z = sway;
    groupRef.current.rotation.x = Math.cos(time * 1.1 * windSpeed) * 0.014 * windSpeed * stiffness;

    // Dynamic Trunk Height & Girth Scaling
    if (trunkScaleGroupRef.current) {
      const heightScale = 0.38 + g * 0.62;
      const thicknessScale = 0.55 + g * 0.45;
      trunkScaleGroupRef.current.scale.set(thicknessScale, heightScale, thicknessScale);
    }

    // Crown scaling expands with growth
    if (crownRef.current) {
      const crownScale = 0.32 + g * 0.78;
      crownRef.current.scale.setScalar(crownScale);
    }

    // Lateral Branch Extensions: emerge smoothly once vitality passes seedling threshold (0.20)
    if (branchesRef.current) {
      const branchProgress = Math.max(0.001, (g - 0.20) / 0.80);
      branchesRef.current.scale.set(branchProgress, branchProgress, branchProgress);
    }

    // Orbiting Golden Pollen / Fireflies Ring in Golden Latch
    if (pollenGroupRef.current) {
      pollenGroupRef.current.rotation.y = time * 0.8;
      pollenGroupRef.current.position.y = 2.4 + Math.sin(time * 2.0) * 0.12;
    }

    // Shimmering celestial god ray
    if (godRayRef.current) {
      godRayRef.current.rotation.y = -time * 0.25;
      const pulse = 0.22 + Math.sin(time * 3.0) * 0.05;
      (godRayRef.current.material as THREE.MeshBasicMaterial).opacity = pulse;
    }
  });

  const isGoldenLatch = vitality >= 1.0;
  const isSprout = vitality < 0.20;

  return (
    <group ref={groupRef} position={position}>
      {/* ================================================================= */}
      {/* 1. SEEDLING / SPROUT METAMORPHOSIS (Vitality < 0.20)              */}
      {/* ================================================================= */}
      {isSprout ? (
        <group position={[0, 0.05, 0]}>
          {/* Soil Loam Mound */}
          <mesh position={[0, 0.04, 0]} receiveShadow>
            <cylinderGeometry args={[0.28, 0.42, 0.08, 8]} />
            <meshStandardMaterial color="#2b1e15" flatShading roughness={0.95} />
          </mesh>

          {/* Slender Arched Green Stem */}
          <mesh position={[0.03, 0.32, 0]} rotation={[0.08, 0, 0.06]} castShadow receiveShadow>
            <cylinderGeometry args={[0.045, 0.075, 0.62, 8]} />
            <meshStandardMaterial color="#52b788" flatShading roughness={0.35} />
          </mesh>

          {/* Left Cotyledon Leaf */}
          <mesh position={[-0.14, 0.62, 0.04]} rotation={[0.4, 0.1, 0.85]} scale={[0.26, 0.06, 0.38]} castShadow>
            <icosahedronGeometry args={[0.8, 1]} />
            <meshStandardMaterial color="#70e000" flatShading roughness={0.4} />
          </mesh>

          {/* Right Cotyledon Leaf */}
          <mesh position={[0.18, 0.64, -0.04]} rotation={[-0.35, -0.1, -0.8]} scale={[0.24, 0.06, 0.35]} castShadow>
            <icosahedronGeometry args={[0.8, 1]} />
            <meshStandardMaterial color="#80ed99" flatShading roughness={0.4} />
          </mesh>

          {/* Tiny Emerging Sprout Bud Node */}
          <mesh position={[0.02, 0.68, 0]} scale={0.08} castShadow>
            <icosahedronGeometry args={[1, 1]} />
            <meshStandardMaterial color="#b7efc5" flatShading roughness={0.3} />
          </mesh>
        </group>
      ) : (
        /* ================================================================= */
        /* 2. MATURE BOTANICAL TREE ARCHITECTURE (Vitality >= 0.20)          */
        /* ================================================================= */
        <>
          {/* A. ORGANIC ROOT BUTTRESSES (Species-Tuned) */}
          <group position={[0, 0.05, 0]}>
            {/* Species 2: Banyan has 4 sprawling heavy buttress roots */}
            {species === 'banyan' && [0, Math.PI / 2, Math.PI, Math.PI * 1.5].map((angle, idx) => (
              <mesh key={idx} rotation={[0, angle, 0]} position={[0.32 * Math.cos(angle), 0.10, 0.32 * Math.sin(angle)]} castShadow>
                <cylinderGeometry args={[0.12, 0.28, 0.55, 6]} />
                <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.92} />
              </mesh>
            ))}

            {/* Species 1, 3, 4: 3 anchored ground root flares */}
            {species !== 'banyan' && [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((angle, idx) => (
              <mesh key={idx} rotation={[0, angle, 0]} position={[0.25 * Math.cos(angle), 0.08, 0.25 * Math.sin(angle)]} castShadow>
                <cylinderGeometry args={[0.09, 0.22, 0.46, 6]} />
                <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
              </mesh>
            ))}

            {/* Base trunk collar anchoring into pedestal */}
            <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
              <cylinderGeometry args={[species === 'banyan' ? 0.38 : 0.32, 0.58, 0.26, 8]} />
              <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
            </mesh>
          </group>

          {/* B. DYNAMIC TRUNK & CANOPY SYSTEM */}
          <group ref={trunkScaleGroupRef} position={[0, 0.25, 0]}>
            {/* --- SPECIES 1: AUTUMN OAK --- */}
            {species === 'oak' && (
              <>
                {/* Main Asymmetric Trunk */}
                <mesh position={[0.03, 0.95, -0.02]} rotation={[0.03, 0, -0.04]} castShadow receiveShadow>
                  <cylinderGeometry args={[0.26, 0.36, 1.85, 8]} />
                  <meshStandardMaterial color={colors.trunk} flatShading roughness={0.88} />
                </mesh>

                {/* Central Billowing Crown Dome */}
                <group ref={crownRef} position={[0, 2.05, 0]}>
                  <mesh position={[0, 0.45, 0]} scale={[1.35, 0.85, 1.3]} castShadow receiveShadow>
                    <icosahedronGeometry args={[0.95, 1]} />
                    <meshStandardMaterial
                      color={colors.foliageHighlight}
                      flatShading
                      roughness={0.7}
                      emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                      emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                    />
                  </mesh>
                </group>

                {/* 3 Asymmetric Spreading Boughs */}
                <group ref={branchesRef} position={[0, 1.5, 0]}>
                  {oakBoughs.map((b, idx) => (
                    <group key={idx} rotation={[0, b.angle, 0]}>
                      <mesh position={[0.55 * b.length, b.elev, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                        <cylinderGeometry args={[0.11, 0.19, b.length, 7]} />
                        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
                      </mesh>
                      <mesh position={[b.length, b.elev + 0.45, 0]} scale={b.scale} castShadow receiveShadow>
                        <icosahedronGeometry args={[0.88, 1]} />
                        <meshStandardMaterial
                          color={idx % 2 === 0 ? colors.foliageBase : colors.foliageHighlight}
                          flatShading
                          roughness={0.7}
                          emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                          emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                        />
                      </mesh>
                      {dewCount > idx * 2 && (
                        <mesh position={[b.length, b.elev + 0.95, 0.25]} scale={0.22} castShadow>
                          <icosahedronGeometry args={[1, 1]} />
                          <meshStandardMaterial color={colors.dew} emissive={colors.dew} emissiveIntensity={1.3} flatShading />
                        </mesh>
                      )}
                    </group>
                  ))}
                </group>
              </>
            )}

            {/* --- SPECIES 2: ANCIENT BANYAN --- */}
            {species === 'banyan' && (
              <>
                {/* Thick Muscular Double Trunk */}
                <mesh position={[0, 0.85, 0]} castShadow receiveShadow>
                  <cylinderGeometry args={[0.34, 0.44, 1.65, 8]} />
                  <meshStandardMaterial color={colors.trunk} flatShading roughness={0.92} />
                </mesh>

                {/* Flat Tiered Canopy Disc */}
                <group ref={crownRef} position={[0, 1.85, 0]}>
                  <mesh position={[0, 0.35, 0]} scale={[1.6, 0.55, 1.55]} castShadow receiveShadow>
                    <icosahedronGeometry args={[0.9, 1]} />
                    <meshStandardMaterial
                      color={colors.foliageHighlight}
                      flatShading
                      roughness={0.7}
                      emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                      emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                    />
                  </mesh>
                </group>

                {/* 4 Heavy Lateral Parasol Boughs */}
                <group ref={branchesRef} position={[0, 1.35, 0]}>
                  {banyanBoughs.map((b, idx) => (
                    <group key={idx} rotation={[0, b.angle, 0]}>
                      <mesh position={[0.55 * b.length, b.elev, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                        <cylinderGeometry args={[0.13, 0.22, b.length, 7]} />
                        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
                      </mesh>
                      <mesh position={[b.length, b.elev + 0.35, 0]} scale={b.scale} castShadow receiveShadow>
                        <icosahedronGeometry args={[0.82, 1]} />
                        <meshStandardMaterial
                          color={idx % 2 === 0 ? colors.foliageBase : colors.foliageHighlight}
                          flatShading
                          roughness={0.7}
                          emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                          emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                        />
                      </mesh>
                      {dewCount > idx * 2 && (
                        <mesh position={[b.length, b.elev + 0.8, 0.2]} scale={0.22} castShadow>
                          <icosahedronGeometry args={[1, 1]} />
                          <meshStandardMaterial color={colors.dew} emissive={colors.dew} emissiveIntensity={1.3} flatShading />
                        </mesh>
                      )}
                    </group>
                  ))}
                </group>
              </>
            )}

            {/* --- SPECIES 3: HIGHLAND PINE / CONIFER --- */}
            {species === 'pine' && (
              <>
                {/* Tall Straight Spine */}
                <mesh position={[0, 1.15, 0]} castShadow receiveShadow>
                  <cylinderGeometry args={[0.15, 0.32, 2.25, 8]} />
                  <meshStandardMaterial color={colors.trunk} flatShading roughness={0.88} />
                </mesh>

                {/* Pointed Pagoda Crown Spire */}
                <group ref={crownRef} position={[0, 2.35, 0]}>
                  <mesh position={[0, 0.35, 0]} scale={[0.75, 1.0, 0.75]} castShadow receiveShadow>
                    <icosahedronGeometry args={[0.9, 1]} />
                    <meshStandardMaterial
                      color={colors.foliageHighlight}
                      flatShading
                      roughness={0.7}
                      emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                      emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                    />
                  </mesh>
                </group>

                {/* Tiered Downward-Sloping Conical Skirts */}
                <group ref={branchesRef} position={[0, 0, 0]}>
                  {pineTiers.map((b, idx) => (
                    <group key={idx} position={[0, b.yPos, 0]} rotation={[0, b.angle, 0]}>
                      <mesh position={[0.48 * b.length, -0.05, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                        <cylinderGeometry args={[0.07, 0.14, b.length, 6]} />
                        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
                      </mesh>
                      <mesh position={[b.length, 0.15, 0]} scale={b.scale} castShadow receiveShadow>
                        <icosahedronGeometry args={[0.78, 1]} />
                        <meshStandardMaterial
                          color={idx % 2 === 0 ? colors.foliageBase : colors.foliageHighlight}
                          flatShading
                          roughness={0.7}
                          emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                          emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                        />
                      </mesh>
                      {dewCount > idx && (
                        <mesh position={[b.length, 0.55, 0.15]} scale={0.2} castShadow>
                          <icosahedronGeometry args={[1, 1]} />
                          <meshStandardMaterial color={colors.dew} emissive={colors.dew} emissiveIntensity={1.3} flatShading />
                        </mesh>
                      )}
                    </group>
                  ))}
                </group>
              </>
            )}

            {/* --- SPECIES 4: WEEPING SAKURA --- */}
            {species === 'sakura' && (
              <>
                {/* Gracefully Sweeping Curved Trunk */}
                <mesh position={[0.08, 0.95, -0.04]} rotation={[0.06, 0.2, -0.08]} castShadow receiveShadow>
                  <cylinderGeometry args={[0.22, 0.32, 1.85, 8]} />
                  <meshStandardMaterial color={colors.trunk} flatShading roughness={0.88} />
                </mesh>

                {/* Soft Rounded Blossom Crown */}
                <group ref={crownRef} position={[0.06, 2.05, 0]}>
                  <mesh position={[0, 0.45, 0]} scale={[1.2, 0.75, 1.15]} castShadow receiveShadow>
                    <icosahedronGeometry args={[0.92, 1]} />
                    <meshStandardMaterial
                      color={colors.foliageHighlight}
                      flatShading
                      roughness={0.7}
                      emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                      emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                    />
                  </mesh>
                </group>

                {/* Graceful Cascading Blossom Boughs */}
                <group ref={branchesRef} position={[0, 1.5, 0]}>
                  {sakuraBoughs.map((b, idx) => (
                    <group key={idx} rotation={[0, b.angle, 0]}>
                      {/* Arched Limb */}
                      <mesh position={[0.55 * b.length, 0.25, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                        <cylinderGeometry args={[0.09, 0.16, b.length, 7]} />
                        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
                      </mesh>

                      {/* Upper Blossom Cloud */}
                      <mesh position={[b.length * 0.85, 0.65, 0]} scale={b.scale} castShadow receiveShadow>
                        <icosahedronGeometry args={[0.82, 1]} />
                        <meshStandardMaterial
                          color={colors.foliageHighlight}
                          flatShading
                          roughness={0.7}
                          emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                          emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                        />
                      </mesh>

                      {/* Lower Cascading Weeping Blossom Cluster */}
                      <mesh position={[b.length * 1.05, 0.25 + b.dip, 0]} scale={[b.scale[0] * 0.85, b.scale[1] * 0.9, b.scale[2] * 0.85]} castShadow receiveShadow>
                        <icosahedronGeometry args={[0.72, 1]} />
                        <meshStandardMaterial
                          color={colors.foliageBase}
                          flatShading
                          roughness={0.7}
                          emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                          emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                        />
                      </mesh>

                      {dewCount > idx * 2 && (
                        <mesh position={[b.length * 0.85, 1.1, 0.2]} scale={0.22} castShadow>
                          <icosahedronGeometry args={[1, 1]} />
                          <meshStandardMaterial color={colors.dew} emissive={colors.dew} emissiveIntensity={1.3} flatShading />
                        </mesh>
                      )}
                    </group>
                  ))}
                </group>
              </>
            )}
          </group>
        </>
      )}

      {/* ================================================================= */}
      {/* 3. GOLDEN LATCH CELEBRATION EFFECTS (Vitality >= 1.0)              */}
      {/* ================================================================= */}
      {isGoldenLatch && (
        <>
          {/* Celestial God Ray Streaming Down */}
          <mesh ref={godRayRef} position={[0, 4.8, 0]}>
            <cylinderGeometry args={[0.3, 2.4, 9.2, 24, 1, true]} />
            <meshBasicMaterial
              color={colors.goldenAura}
              transparent
              opacity={0.22}
              side={THREE.DoubleSide}
              depthWrite={false}
              blending={THREE.AdditiveBlending}
            />
          </mesh>

          {/* Orbiting Golden Pollen / Fireflies Ring */}
          <group ref={pollenGroupRef}>
            {[0, 1, 2, 3, 4, 5].map((i) => {
              const pAngle = (i * Math.PI * 2) / 6;
              const radius = 1.45;
              return (
                <mesh key={i} position={[Math.cos(pAngle) * radius, Math.sin(i * 1.2) * 0.3, Math.sin(pAngle) * radius]} scale={0.12}>
                  <icosahedronGeometry args={[1, 1]} />
                  <meshBasicMaterial color={colors.goldenAura} />
                </mesh>
              );
            })}
          </group>

          {/* Blossoming Floral Crest crowning the peak */}
          <mesh position={[0, 3.1, 0]} scale={0.35}>
            <icosahedronGeometry args={[1, 1]} />
            <meshStandardMaterial
              color={colors.goldenAura}
              emissive={colors.goldenAura}
              emissiveIntensity={1.6}
              flatShading
            />
          </mesh>
        </>
      )}

      {/* ================================================================= */}
      {/* 4. TEAM PEDESTAL RUNIC RING                                       */}
      {/* ================================================================= */}
      <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.1, 1.3, 32]} />
        <meshBasicMaterial
          color={isGoldenLatch ? colors.goldenAura : colors.pedestalGlow}
          transparent
          opacity={isGoldenLatch ? 0.95 : 0.75}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
