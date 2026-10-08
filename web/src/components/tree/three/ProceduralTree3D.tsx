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
  const crownRef = useRef<THREE.Group>(null);
  const branchGroupRef = useRef<THREE.Group>(null);
  const currentGrowthRef = useRef(0.15);
  const colors = TEAM_3D_PALETTES[teamNumber] || TEAM_3D_PALETTES[1];

  // 3 Primary boughs spread radially at 120° angles
  const branchConfigs = useMemo(() => [
    { angle: 0, tilt: 0.55, length: 1.2, scale: 1.0 },
    { angle: (Math.PI * 2) / 3, tilt: 0.52, length: 1.15, scale: 0.95 },
    { angle: (Math.PI * 4) / 3, tilt: 0.58, length: 1.25, scale: 1.05 }
  ], []);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const time = state.clock.elapsedTime;

    // Smooth growth interpolation
    const target = Math.max(0.12, vitality);
    currentGrowthRef.current += (target - currentGrowthRef.current) * Math.min(1, delta * 3.0);
    const g = currentGrowthRef.current;

    // Gentle wind physics
    const sway = Math.sin(time * 1.5 * windSpeed + teamNumber * 1.3) * 0.03 * windSpeed;
    groupRef.current.rotation.z = sway;
    groupRef.current.rotation.x = Math.cos(time * 1.1 * windSpeed) * 0.015 * windSpeed;

    // Crown scale expands with growth
    if (crownRef.current) {
      const crownScale = 0.3 + g * 0.9;
      crownRef.current.scale.setScalar(crownScale);
    }

    // Branch extensions: side branches emerge once vitality > 0.2
    if (branchGroupRef.current) {
      const branchProgress = Math.max(0.001, (g - 0.2) / 0.8);
      branchGroupRef.current.scale.set(branchProgress, branchProgress, branchProgress);
    }
  });

  const isGoldenLatch = vitality >= 1.0;

  return (
    <group ref={groupRef} position={position}>
      {/* 1. ROOT BASE */}
      <mesh position={[0, 0.15, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.35, 0.65, 0.3, 8]} />
        <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
      </mesh>

      {/* 2. MAIN TRUNK */}
      <mesh position={[0, 1.1, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.26, 0.38, 1.6, 8]} />
        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.88} />
      </mesh>

      {/* 3. CENTRAL CROWN (Crown foliage that exists even at low vitality) */}
      <group ref={crownRef} position={[0, 2.1, 0]}>
        <mesh position={[0, 0.6, 0]} castShadow receiveShadow>
          <icosahedronGeometry args={[1.05, 1]} />
          <meshStandardMaterial
            color={isGoldenLatch ? colors.goldenAura : colors.foliageHighlight}
            flatShading
            roughness={0.7}
            emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
            emissiveIntensity={isGoldenLatch ? 0.35 : 0}
          />
        </mesh>
      </group>

      {/* 4. RADIAL SIDE BRANCHES (Parents of secondary canopy clusters) */}
      <group ref={branchGroupRef} position={[0, 1.7, 0]}>
        {branchConfigs.map((b, idx) => {
          return (
            <group key={idx} rotation={[0, b.angle, 0]}>
              {/* Branch Cylinder */}
              <mesh position={[0.45 * b.length, 0.35, 0]} rotation={[0, 0, -b.tilt]} castShadow>
                <cylinderGeometry args={[0.11, 0.18, b.length, 7]} />
                <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
              </mesh>

              {/* Foliage Cloud attached securely at the branch tip */}
              <mesh position={[0.9 * b.length, 0.8, 0]} scale={0.95 * b.scale} castShadow receiveShadow>
                <icosahedronGeometry args={[0.9, 1]} />
                <meshStandardMaterial
                  color={isGoldenLatch ? colors.goldenAura : (idx % 2 === 0 ? colors.foliageBase : colors.foliageHighlight)}
                  flatShading
                  roughness={0.7}
                  emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
                  emissiveIntensity={isGoldenLatch ? 0.35 : 0}
                />
              </mesh>

              {/* Dew drops nested on branch leaves */}
              {dewCount > idx * 2 && (
                <mesh position={[0.9 * b.length, 1.25, 0.3]} scale={0.2} castShadow>
                  <icosahedronGeometry args={[1, 1]} />
                  <meshStandardMaterial
                    color={colors.dew}
                    emissive={colors.dew}
                    emissiveIntensity={1.2}
                    flatShading
                  />
                </mesh>
              )}
            </group>
          );
        })}
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
