'use client';

import React, { useRef } from 'react';
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
  const currentScaleRef = useRef(0.1);
  const colors = TEAM_3D_PALETTES[teamNumber] || TEAM_3D_PALETTES[1];

  // Dynamic growth spring physics & harmonic wind sway
  useFrame((state, delta) => {
    if (!groupRef.current) return;
    const time = state.clock.getElapsedTime();

    // Lerp scale towards vitality
    const targetScale = Math.max(0.15, vitality);
    currentScaleRef.current += (targetScale - currentScaleRef.current) * Math.min(1, delta * 3.5);
    
    // Ambient wind harmonic oscillation
    const wind = Math.sin(time * 1.5 * windSpeed + teamNumber) * 0.04 * windSpeed;
    groupRef.current.rotation.z = wind;
    groupRef.current.rotation.x = Math.cos(time * 1.2 * windSpeed) * 0.02 * windSpeed;
  });

  const isGoldenLatch = vitality >= 1.0;

  return (
    <group ref={groupRef} position={position}>
      {/* 1. THÂN CÂY KHỐI TRỤ (Volumetric Trunk) */}
      <mesh position={[0, 1.5, 0]} castShadow receiveShadow>
        <cylinderGeometry args={[0.25, 0.55, 3, 16]} />
        <meshStandardMaterial 
          color={colors.trunk} 
          roughness={0.85} 
          metalness={0.1}
        />
      </mesh>

      {/* 2. CÁC NHÁNH CÂY CẤP 1 (Primary Branches) */}
      <group position={[0, 2.2, 0]}>
        <mesh position={[-0.6, 0.4, 0]} rotation={[0, 0, 0.6]} castShadow>
          <cylinderGeometry args={[0.15, 0.22, 1.4, 12]} />
          <meshStandardMaterial color={colors.trunk} roughness={0.85} />
        </mesh>
        <mesh position={[0.6, 0.4, 0]} rotation={[0, 0, -0.6]} castShadow>
          <cylinderGeometry args={[0.15, 0.22, 1.4, 12]} />
          <meshStandardMaterial color={colors.trunk} roughness={0.85} />
        </mesh>
      </group>

      {/* 3. TÁN LÁ KHỐI THỂ TÍCH (Stylized Volumetric Canopies) */}
      <group position={[0, 3.2, 0]} scale={Math.max(0.2, vitality * 1.2)}>
        {/* Tán trung tâm */}
        <mesh position={[0, 0.5, 0]} castShadow>
          <dodecahedronGeometry args={[1.3, 1]} />
          <meshStandardMaterial 
            color={isGoldenLatch ? colors.goldenAura : colors.foliageHighlight} 
            roughness={0.4} 
            emissive={isGoldenLatch ? colors.goldenAura : '#000000'}
            emissiveIntensity={isGoldenLatch ? 0.35 : 0}
          />
        </mesh>
        {/* Tán nhánh trái */}
        <mesh position={[-1.1, 0, 0.2]} castShadow>
          <dodecahedronGeometry args={[0.9, 1]} />
          <meshStandardMaterial 
            color={isGoldenLatch ? colors.goldenAura : colors.foliageBase} 
            roughness={0.45} 
          />
        </mesh>
        {/* Tán nhánh phải */}
        <mesh position={[1.1, 0, -0.2]} castShadow>
          <dodecahedronGeometry args={[0.9, 1]} />
          <meshStandardMaterial 
            color={isGoldenLatch ? colors.goldenAura : colors.foliageBase} 
            roughness={0.45} 
          />
        </mesh>
      </group>

      {/* 4. GIỌT SƯƠNG / HOA NỞ PHÁT SÁNG (Popping 3D Dew Drops) */}
      {dewCount > 0 && (
        <group position={[0, 3.0, 0]}>
          {Array.from({ length: Math.min(dewCount, 12) }).map((_, i) => {
            const angle = (i / Math.min(dewCount, 12)) * Math.PI * 2;
            const radius = 1.35;
            const x = Math.cos(angle) * radius;
            const z = Math.sin(angle) * radius;
            return (
              <mesh key={i} position={[x, Math.sin(i) * 0.4, z]}>
                <sphereGeometry args={[0.18, 16, 16]} />
                <meshStandardMaterial 
                  color={colors.dew} 
                  emissive={colors.dew} 
                  emissiveIntensity={0.8} 
                  roughness={0.1}
                />
              </mesh>
            );
          })}
        </group>
      )}

      {/* 5. VÒNG SÁNG CÁN ĐÍCH (Golden Aura) */}
      {isGoldenLatch && (
        <mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[1.5, 1.8, 32]} />
          <meshBasicMaterial color={colors.goldenAura} side={THREE.DoubleSide} transparent opacity={0.6} />
        </mesh>
      )}
    </group>
  );
}
