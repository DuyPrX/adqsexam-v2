'use client';

import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, ContactShadows } from '@react-three/drei';
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
      camera.position.set(0, 3.5, 13);
    } else if (preset === 'perspective') {
      camera.position.set(6, 6, 12);
    } else if (preset === 'top') {
      camera.position.set(0, 16, 7);
    }
    camera.lookAt(0, 2, 0);
    if (controlsRef.current) {
      controlsRef.current.target.set(0, 2, 0);
      controlsRef.current.update();
    }
  }, [preset, camera]);

  return enableOrbit ? (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      maxPolarAngle={Math.PI / 2 - 0.05}
      minDistance={6}
      maxDistance={25}
    />
  ) : null;
}

export default function ArenaStage3D({
  trees,
  windSpeed = 1.0,
  enableOrbit = true,
  cameraPreset = 'perspective'
}: ArenaStage3DProps) {
  // 4 Trees arranged across the stage (X: -6, -2, 2, 6)
  const treePositions: [number, number, number][] = [
    [-6, 0, 0],
    [-2, 0, 0],
    [2, 0, 0],
    [6, 0, 0]
  ];

  return (
    <div className="w-full h-full relative bg-gradient-to-b from-slate-900 via-indigo-950 to-slate-950">
      <Canvas
        shadows
        gl={{ preserveDrawingBuffer: true, antialias: true }}
        camera={{ position: [0, 4.5, 12], fov: 45 }}
      >
        {/* 1. LIGHTING SETUP */}
        <ambientLight intensity={0.65} />
        <directionalLight
          position={[10, 15, 10]}
          intensity={1.4}
          castShadow
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
          shadow-bias={-0.0001}
        />
        <pointLight position={[-10, 5, -5]} intensity={0.4} color="#818cf8" />

        {/* 2. THE 4 3D TREES */}
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

        {/* 3. GROUND PEDESTAL & CONTACT SHADOWS */}
        <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <planeGeometry args={[26, 12]} />
          <meshStandardMaterial color="#1e293b" roughness={0.9} />
        </mesh>
        <ContactShadows position={[0, 0, 0]} opacity={0.7} scale={24} blur={1.5} far={4.5} />

        {/* 4. CONTROLS & CAMERA */}
        <CameraController preset={cameraPreset} enableOrbit={enableOrbit} />
      </Canvas>
    </div>
  );
}
