'use client';

import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { TEAM_3D_PALETTES } from '@/lib/tree3d';

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
  const currentGrowthRef = useRef(0.15);
  const colors = TEAM_3D_PALETTES[teamNumber] || TEAM_3D_PALETTES[1];

  // 3 Sturdy Boughs extending outward
  const boughConfigs = useMemo(() => [
    { angle: 0, tilt: 0.62, length: 1.45, scale: [1.2, 0.7, 1.1] as [number, number, number] },
    { angle: (Math.PI * 2) / 3, tilt: 0.58, length: 1.4, scale: [1.1, 0.65, 1.0] as [number, number, number] },
    { angle: (Math.PI * 4) / 3, tilt: 0.65, length: 1.5, scale: [1.25, 0.75, 1.15] as [number, number, number] }
  ], []);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const time = state.clock.elapsedTime;

    const target = Math.max(0.12, vitality);
    currentGrowthRef.current += (target - currentGrowthRef.current) * Math.min(1, delta * 3.0);
    const g = currentGrowthRef.current;

    // Harmonic wind sway
    const sway = Math.sin(time * 1.5 * windSpeed + teamNumber * 1.3) * 0.03 * windSpeed;
    groupRef.current.rotation.z = sway;
    groupRef.current.rotation.x = Math.cos(time * 1.1 * windSpeed) * 0.015 * windSpeed;

    // Dynamic Trunk Height Scaling: Cute small sprout -> Tall majestic tree
    if (trunkScaleGroupRef.current) {
      const heightScale = 0.38 + g * 0.62;
      const thicknessScale = 0.6 + g * 0.4;
      trunkScaleGroupRef.current.scale.set(thicknessScale, heightScale, thicknessScale);
    }

    // Central Crown Scaling
    if (crownRef.current) {
      const crownScale = 0.35 + g * 0.75;
      crownRef.current.scale.setScalar(crownScale);
    }

    // Lateral Branch Extensions: extend after vitality > 0.22
    if (branchesRef.current) {
      const branchProgress = Math.max(0.001, (g - 0.22) / 0.78);
      branchesRef.current.scale.set(branchProgress, branchProgress, branchProgress);
    }
  });

  const isGoldenLatch = vitality >= 1.0;

  return (
    <group ref={groupRef} position={position}>
      {/* 1. ROOT SPREAD (3 rễ phụ uốn cong cắm đất) */}
      <group position={[0, 0.05, 0]}>
        {[0, (Math.PI * 2) / 3, (Math.PI * 4) / 3].map((angle, idx) => (
          <mesh key={idx} rotation={[0, angle, 0]} position={[0.25 * Math.cos(angle), 0.08, 0.25 * Math.sin(angle)]} castShadow>
            <cylinderGeometry args={[0.08, 0.22, 0.45, 6]} />
            <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
          </mesh>
        ))}
        {/* Base trunk collar */}
        <mesh position={[0, 0.12, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.32, 0.55, 0.25, 8]} />
          <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
        </mesh>
      </group>

      {/* 2. DYNAMICALLY SCALED MAIN TRUNK */}
      <group ref={trunkScaleGroupRef} position={[0, 0.25, 0]}>
        <mesh position={[0, 0.9, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.24, 0.34, 1.8, 8]} />
          <meshStandardMaterial color={colors.trunk} flatShading roughness={0.88} />
        </mesh>

        {/* 3. CENTRAL TOP CROWN PAD */}
        <group ref={crownRef} position={[0, 1.9, 0]}>
          <mesh position={[0, 0.45, 0]} scale={[1.1, 0.75, 1.0]} castShadow receiveShadow>
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

        {/* 4. THREE OUTWARD RADIAL BOUGHS (Lộ rõ cành gỗ nâng đỡ lá) */}
        <group ref={branchesRef} position={[0, 1.45, 0]}>
          {boughConfigs.map((b, idx) => (
            <group key={idx} rotation={[0, b.angle, 0]}>
              {/* Prominent Wooden Branch */}
              <mesh position={[0.55 * b.length, 0.3, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                <cylinderGeometry args={[0.1, 0.18, b.length, 7]} />
                <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
              </mesh>

              {/* Tiered Foliage Cloud Pad sitting on top of the branch */}
              <mesh position={[b.length, 0.7, 0]} scale={b.scale} castShadow receiveShadow>
                <icosahedronGeometry args={[0.85, 1]} />
                <meshStandardMaterial
                  color={idx % 2 === 0 ? colors.foliageBase : colors.foliageHighlight}
                  flatShading
                  roughness={0.7}
                  emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                  emissiveIntensity={isGoldenLatch ? 0.25 : 0}
                />
              </mesh>

              {/* Dew Drops nestled on cloud pad */}
              {dewCount > idx * 2 && (
                <mesh position={[b.length, 1.15, 0.25]} scale={0.22} castShadow>
                  <icosahedronGeometry args={[1, 1]} />
                  <meshStandardMaterial
                    color={colors.dew}
                    emissive={colors.dew}
                    emissiveIntensity={1.3}
                    flatShading
                  />
                </mesh>
              )}
            </group>
          ))}
        </group>
      </group>

      {/* 5. TEAM PEDESTAL RUNIC RING */}
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
