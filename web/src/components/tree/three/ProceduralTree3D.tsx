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
  const foliageRef = useRef<THREE.Group>(null);
  const currentGrowthRef = useRef(0.15);
  const colors = TEAM_3D_PALETTES[teamNumber] || TEAM_3D_PALETTES[1];

  // Natural foliage cluster distribution (asymmetrical and organic)
  const canopyClusters = useMemo(() => [
    { pos: [0, 1.2, 0] as [number, number, number], scale: 1.45, isHighlight: false },
    { pos: [-0.85, 0.6, 0.4] as [number, number, number], scale: 1.15, isHighlight: true },
    { pos: [0.95, 0.7, -0.3] as [number, number, number], scale: 1.2, isHighlight: false },
    { pos: [0.1, 1.9, -0.2] as [number, number, number], scale: 1.05, isHighlight: true },
    { pos: [-0.4, 0.8, -0.8] as [number, number, number], scale: 0.95, isHighlight: false },
    { pos: [0.5, 0.5, 0.7] as [number, number, number], scale: 0.9, isHighlight: true },
  ], []);

  // Compute dew positions directly anchored to canopy surfaces
  const dewPositions = useMemo(() => {
    const list: [number, number, number][] = [];
    const count = 12;
    for (let i = 0; i < count; i++) {
      const cluster = canopyClusters[i % canopyClusters.length];
      const angle = (i * 2.39996); // Golden ratio angle
      const r = 0.95 * cluster.scale;
      list.push([
        cluster.pos[0] + Math.cos(angle) * r,
        cluster.pos[1] + (Math.sin(i) * 0.4) * cluster.scale,
        cluster.pos[2] + Math.sin(angle) * r
      ]);
    }
    return list;
  }, [canopyClusters]);

  useFrame((state, delta) => {
    if (!groupRef.current) return;
    // Safe clock reading without deprecation
    const time = state.clock.elapsedTime;

    // Smooth growth lerp
    const target = Math.max(0.15, vitality);
    currentGrowthRef.current += (target - currentGrowthRef.current) * Math.min(1, delta * 3.5);

    // Natural harmonic wind swaying
    const sway = Math.sin(time * 1.6 * windSpeed + teamNumber * 1.5) * 0.035 * windSpeed;
    const twist = Math.cos(time * 1.1 * windSpeed + teamNumber) * 0.02 * windSpeed;
    groupRef.current.rotation.z = sway;
    groupRef.current.rotation.x = twist;

    if (foliageRef.current) {
      // Breathing scale pulse
      const breathe = 1 + Math.sin(time * 2.2 + teamNumber) * 0.015;
      foliageRef.current.scale.setScalar(currentGrowthRef.current * breathe);
    }
  });

  const isGoldenLatch = vitality >= 1.0;

  return (
    <group ref={groupRef} position={position}>
      {/* 1. ROOT FLARE (Chân rễ bám đất vững chãi) */}
      <mesh position={[0, 0.25, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.42, 0.85, 0.5, 8]} />
        <meshStandardMaterial color={colors.trunkDark} flatShading roughness={0.9} />
      </mesh>

      {/* 2. LOWER TAPERED TRUNK (Thân dưới uốn lượn) */}
      <mesh position={[0, 1.2, 0]} rotation={[0.03, 0, -0.02]} castShadow receiveShadow>
        <cylinderGeometry args={[0.3, 0.45, 1.5, 8]} />
        <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
      </mesh>

      {/* 3. UPPER TRUNK & BRANCH FORKS (Thân trên đâm cành) */}
      <group position={[0, 2.0, 0]}>
        <mesh position={[0, 0.4, 0]} castShadow>
          <cylinderGeometry args={[0.22, 0.3, 0.9, 8]} />
          <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
        </mesh>
        {/* Nhánh trái */}
        <mesh position={[-0.45, 0.35, 0.1]} rotation={[0, 0, 0.65]} castShadow>
          <cylinderGeometry args={[0.14, 0.22, 1.0, 7]} />
          <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
        </mesh>
        {/* Nhánh phải */}
        <mesh position={[0.5, 0.4, -0.1]} rotation={[0, 0, -0.6]} castShadow>
          <cylinderGeometry args={[0.14, 0.22, 1.1, 7]} />
          <meshStandardMaterial color={colors.trunk} flatShading roughness={0.9} />
        </mesh>
      </group>

      {/* 4. FACETED LOW-POLY CANOPY (Tán lá đa diện giác cắt tinh thể) */}
      <group ref={foliageRef} position={[0, 2.7, 0]}>
        {canopyClusters.map((cluster, i) => (
          <mesh
            key={i}
            position={cluster.pos}
            scale={cluster.scale}
            castShadow
            receiveShadow
          >
            {/* Icosahedron detail=1 creates beautiful diamond-like facets */}
            <icosahedronGeometry args={[1.0, 1]} />
            <meshStandardMaterial
              color={
                isGoldenLatch
                  ? colors.goldenAura
                  : cluster.isHighlight
                  ? colors.foliageHighlight
                  : colors.foliageBase
              }
              flatShading
              roughness={0.7}
              emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
              emissiveIntensity={isGoldenLatch ? 0.4 : 0}
            />
          </mesh>
        ))}

        {/* 5. ORGANIC DEW DROPS / GLOWING FRUITS */}
        {dewCount > 0 &&
          dewPositions.slice(0, Math.min(dewCount, 12)).map((pos, idx) => (
            <mesh key={idx} position={pos} scale={0.22} castShadow>
              <icosahedronGeometry args={[1, 1]} />
              <meshStandardMaterial
                color={colors.dew}
                emissive={colors.dew}
                emissiveIntensity={1.4}
                flatShading
                roughness={0.2}
              />
            </mesh>
          ))}
      </group>

      {/* 6. GLOWING TEAM RUNIC BASE RING */}
      <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[1.15, 1.35, 32]} />
        <meshBasicMaterial
          color={isGoldenLatch ? colors.goldenAura : colors.pedestalGlow}
          transparent
          opacity={isGoldenLatch ? 0.95 : 0.65}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
