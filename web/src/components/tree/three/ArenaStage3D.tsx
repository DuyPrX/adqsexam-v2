'use client';

import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, ContactShadows, Sparkles } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import * as THREE from 'three';
import ProceduralTree3D from './ProceduralTree3D';

export interface TreeStageData {
  teamNumber: number;
  vitality: number; // 0.0 -> 1.0
  dewCount: number;
}

export type CameraPreset = 'front' | 'perspective' | 'top';

interface ArenaStage3DProps {
  trees: TreeStageData[];
  windSpeed?: number;
  enableOrbit?: boolean;
  cameraPreset?: CameraPreset;
}

function CameraController({ preset, enableOrbit }: { preset?: CameraPreset; enableOrbit?: boolean }) {
  const { camera } = useThree();
  const controlsRef = useRef<OrbitControlsImpl>(null);

  useEffect(() => {
    if (!preset) return;
    if (preset === 'front') {
      camera.position.set(0, 3.5, 14);
    } else if (preset === 'perspective') {
      camera.position.set(0, 4.2, 13.5);
    } else if (preset === 'top') {
      camera.position.set(0, 16, 7);
    }
    camera.lookAt(0, 2.0, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 2.0, 0);
      controlsRef.current.update();
    }
  }, [preset, camera]);

  return enableOrbit ? (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={[0, 2.0, 0]}
      maxPolarAngle={Math.PI / 2 - 0.05}
      minDistance={7}
      maxDistance={22}
    />
  ) : null;
}

export default function ArenaStage3D({
  trees,
  windSpeed = 1.0,
  enableOrbit = true,
  cameraPreset = 'perspective'
}: ArenaStage3DProps) {
  const treePositions: [number, number, number][] = [
    [-6.3, 0, 0],
    [-2.1, 0, 0],
    [2.1, 0, 0],
    [6.3, 0, 0]
  ];

  return (
    <div className="w-full h-full relative">
      <Canvas
        shadows={{ type: THREE.PCFShadowMap }}
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [0, 4.2, 13.5], fov: 42 }}
      >
        {/* IN-SCENE SKY BACKGROUND (Ensures PNG snapshot captures deep night sky) */}
        <color attach="background" args={['#080e1a']} />
        <fog attach="fog" args={['#080e1a', 15, 38]} />

        {/* LIGHTING SETUP */}
        <ambientLight intensity={0.8} />
        <directionalLight
          position={[10, 16, 12]}
          intensity={1.7}
          color="#fffaf0"
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        <directionalLight position={[-10, 6, -10]} intensity={0.4} color="#818cf8" />

        {/* MAGICAL SPORES / FIREFLIES */}
        <Sparkles count={45} scale={[22, 7, 10]} size={2.5} speed={0.4} opacity={0.5} color="#93c5fd" />

        {/* DIORAMA PLATFORM TERRACE */}
        <group position={[0, -0.05, 0]}>
          {/* Main Flat Floating Terrace */}
          <mesh position={[0, -0.25, 0]} receiveShadow>
            <cylinderGeometry args={[10.5, 10.0, 0.45, 48]} />
            <meshStandardMaterial color="#1e293b" roughness={0.8} flatShading />
          </mesh>

          {/* Undercliff Foundation */}
          <mesh position={[0, -1.8, 0]}>
            <cylinderGeometry args={[9.8, 5.5, 2.7, 16]} />
            <meshStandardMaterial color="#0f172a" roughness={0.95} flatShading />
          </mesh>

          {/* 4 Team Circular Stone Pedestals */}
          {treePositions.map((pos, idx) => (
            <mesh key={idx} position={[pos[0], 0.05, pos[2]]} receiveShadow>
              <cylinderGeometry args={[1.45, 1.55, 0.12, 24]} />
              <meshStandardMaterial color="#334155" roughness={0.7} />
            </mesh>
          ))}
        </group>

        {/* CONTACT SHADOWS */}
        <ContactShadows position={[0, 0.02, 0]} opacity={0.7} scale={22} blur={1.6} far={4} />

        {/* THE 4 PROCEDURAL TREES */}
        {trees.map((t, idx) => (
          <ProceduralTree3D
            key={t.teamNumber}
            teamNumber={t.teamNumber}
            vitality={t.vitality}
            dewCount={t.dewCount}
            windSpeed={windSpeed}
            position={treePositions[idx] || [0, 0, 0]}
          />
        ))}

        {/* CONTROLS */}
        <CameraController preset={cameraPreset} enableOrbit={enableOrbit} />
      </Canvas>
    </div>
  );
}
