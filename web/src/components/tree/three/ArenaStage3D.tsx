'use client';

import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, ContactShadows, Sparkles } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
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
      camera.position.set(0, 4.5, 13.5);
    } else if (preset === 'top') {
      camera.position.set(0, 16, 7);
    }
    camera.lookAt(0, 2.2, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 2.2, 0);
      controlsRef.current.update();
    }
  }, [preset, camera]);

  return enableOrbit ? (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      target={[0, 2.2, 0]}
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
    [-6.5, 0, 0],
    [-2.2, 0, 0],
    [2.2, 0, 0],
    [6.5, 0, 0]
  ];

  return (
    <div className="w-full h-full relative bg-gradient-to-b from-slate-950 via-slate-900 to-indigo-950">
      <Canvas
        shadows
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [0, 4.5, 13.5], fov: 42 }}
      >
        {/* Atmospheric Fog */}
        <fog attach="fog" args={['#090d16', 16, 36]} />

        {/* 1. STUDIO WARM LIGHTING SETUP */}
        <ambientLight intensity={0.7} />
        <directionalLight
          position={[12, 18, 10]}
          intensity={1.8}
          color="#fffbeb"
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0001}
        />
        {/* Soft cool backlight */}
        <directionalLight position={[-10, 8, -10]} intensity={0.5} color="#818cf8" />

        {/* 2. FLOATING SPORES / MAGICAL FIREFLIES */}
        <Sparkles count={50} scale={[24, 8, 12]} size={2.8} speed={0.5} opacity={0.5} color="#67e8f9" />

        {/* 3. DIORAMA FLOATING ISLAND (Hòn đảo lơ lửng) */}
        <group position={[0, -0.05, 0]}>
          {/* Grassy Top Plateau */}
          <mesh position={[0, -0.2, 0]} receiveShadow>
            <cylinderGeometry args={[12.5, 12.0, 0.4, 32]} />
            <meshStandardMaterial color="#2d4a22" roughness={0.85} flatShading />
          </mesh>
          {/* Rocky Earth Cliff Base */}
          <mesh position={[0, -1.8, 0]}>
            <cylinderGeometry args={[12.0, 7.5, 2.8, 16]} />
            <meshStandardMaterial color="#261c14" roughness={0.95} flatShading />
          </mesh>

          {/* 4 Team Stone Pedestals */}
          {treePositions.map((pos, idx) => (
            <mesh key={idx} position={[pos[0], 0.05, pos[2]]} receiveShadow>
              <cylinderGeometry args={[1.5, 1.65, 0.15, 24]} />
              <meshStandardMaterial color="#334155" roughness={0.75} />
            </mesh>
          ))}
        </group>

        {/* Contact Shadows grounding the trees */}
        <ContactShadows position={[0, 0.1, 0]} opacity={0.75} scale={26} blur={1.8} far={4} />

        {/* 4. THE 4 LOW-POLY TREES */}
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

        {/* 5. CONTROLS & CAMERA */}
        <CameraController preset={cameraPreset} enableOrbit={enableOrbit} />
      </Canvas>
    </div>
  );
}
