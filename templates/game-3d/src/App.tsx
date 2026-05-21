import { useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { KeyboardControls, useKeyboardControls, Html, OrbitControls } from '@react-three/drei';
import { Physics, RigidBody, RapierRigidBody } from '@react-three/rapier';
import { useGame } from './store';

// Map named controls to keys. Read them per-frame with useKeyboardControls.
const controls = [
  { name: 'jump', keys: ['Space'] },
];

// A dynamic cube that hops when you press space. Hot-path input is read via
// the keyboard subscription, never through React state (SPEC: keep re-renders
// out of the frame loop).
function Player() {
  const body = useRef<RapierRigidBody>(null);
  const sub = useKeyboardControls((s) => s.jump);
  const bump = useGame((s) => s.bump);

  function jump() {
    if (!body.current) return;
    body.current.applyImpulse({ x: 0, y: 4, z: 0 }, true);
    bump();
  }

  // Fire jump on the rising edge of the space key.
  if (sub) jump();

  return (
    <RigidBody ref={body} colliders="cuboid" restitution={0.4} position={[0, 3, 0]}>
      <mesh castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#4fd1c5" />
      </mesh>
    </RigidBody>
  );
}

function Floor() {
  return (
    <RigidBody type="fixed" colliders="cuboid">
      <mesh receiveShadow position={[0, -0.5, 0]}>
        <boxGeometry args={[20, 1, 20]} />
        <meshStandardMaterial color="#2d3748" />
      </mesh>
    </RigidBody>
  );
}

function Hud() {
  const jumps = useGame((s) => s.jumps);
  return (
    <Html fullscreen style={{ pointerEvents: 'none' }}>
      <div style={{ padding: '1rem', color: '#cbd5e0', fontFamily: 'system-ui, sans-serif' }}>
        <strong><NAME></strong> — press <kbd>Space</kbd> to jump · jumps: {jumps}
      </div>
    </Html>
  );
}

export default function App() {
  return (
    <KeyboardControls map={controls}>
      <Canvas shadows camera={{ position: [6, 6, 6], fov: 50 }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 10, 5]} intensity={1.2} castShadow />
        <Physics gravity={[0, -9.81, 0]}>
          <Player />
          <Floor />
        </Physics>
        <OrbitControls />
        <Hud />
      </Canvas>
    </KeyboardControls>
  );
}
