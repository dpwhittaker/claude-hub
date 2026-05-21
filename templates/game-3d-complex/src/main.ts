import {
  Engine,
  Scene,
  ArcRotateCamera,
  HemisphericLight,
  Vector3,
  MeshBuilder,
  HavokPlugin,
  PhysicsAggregate,
  PhysicsShapeType,
} from '@babylonjs/core';
import HavokPhysics from '@babylonjs/havok';

const canvas = document.getElementById('renderCanvas') as HTMLCanvasElement;
const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });

async function createScene(): Promise<Scene> {
  const scene = new Scene(engine);

  const camera = new ArcRotateCamera('cam', -Math.PI / 2, Math.PI / 3, 16, Vector3.Zero(), scene);
  camera.attachControl(canvas, true);
  new HemisphericLight('light', new Vector3(0, 1, 0), scene);

  // Havok physics (WASM). Spheres drop onto a static ground and bounce.
  const havok = await HavokPhysics();
  scene.enablePhysics(new Vector3(0, -9.81, 0), new HavokPlugin(true, havok));

  const ground = MeshBuilder.CreateGround('ground', { width: 20, height: 20 }, scene);
  new PhysicsAggregate(ground, PhysicsShapeType.BOX, { mass: 0 }, scene);

  for (let i = 0; i < 5; i++) {
    const sphere = MeshBuilder.CreateSphere(`s${i}`, { diameter: 1.5 }, scene);
    sphere.position.set((i - 2) * 1.2, 6 + i, 0);
    new PhysicsAggregate(sphere, PhysicsShapeType.SPHERE, { mass: 1, restitution: 0.6 }, scene);
  }

  // Toggle the Babylon Inspector with the `i` key. Loaded lazily so it stays
  // out of the production bundle unless opened.
  window.addEventListener('keydown', async (e) => {
    if (e.key !== 'i') return;
    await import('@babylonjs/inspector');
    if (scene.debugLayer.isVisible()) scene.debugLayer.hide();
    else scene.debugLayer.show({ embedMode: true });
  });

  return scene;
}

createScene().then((scene) => {
  engine.runRenderLoop(() => scene.render());
});

window.addEventListener('resize', () => engine.resize());
