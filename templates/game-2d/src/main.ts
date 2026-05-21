import Phaser from 'phaser';

// Demo scene: a player rectangle the user drives with the arrow keys, plus a
// bouncing ball, both under Arcade physics with world bounds. Replace this
// with your game — Phaser scenes, sprites, tilemaps, etc.
class MainScene extends Phaser.Scene {
  private player!: Phaser.Types.Physics.Arcade.GameObjectWithDynamicBody;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private label!: Phaser.GameObjects.Text;

  constructor() {
    super('main');
  }

  create() {
    // Player: a 40x40 box that collides with the world edges.
    const box = this.add.rectangle(120, 120, 40, 40, 0x4fd1c5);
    this.physics.add.existing(box);
    this.player = box as unknown as Phaser.Types.Physics.Arcade.GameObjectWithDynamicBody;
    this.player.body.setCollideWorldBounds(true);

    // A ball that bounces around forever.
    const ball = this.add.circle(400, 300, 16, 0xf6ad55);
    this.physics.add.existing(ball);
    const b = (ball as unknown as Phaser.Types.Physics.Arcade.GameObjectWithDynamicBody).body;
    b.setCollideWorldBounds(true);
    b.setBounce(1, 1);
    b.setVelocity(180, 140);

    this.cursors = this.input.keyboard!.createCursorKeys();
    this.label = this.add.text(12, 12, 'Arrow keys to move', {
      color: '#cbd5e0',
      fontFamily: 'system-ui, sans-serif',
      fontSize: '16px',
    });
  }

  update() {
    const speed = 240;
    const body = this.player.body;
    body.setVelocity(0);
    if (this.cursors.left.isDown) body.setVelocityX(-speed);
    else if (this.cursors.right.isDown) body.setVelocityX(speed);
    if (this.cursors.up.isDown) body.setVelocityY(-speed);
    else if (this.cursors.down.isDown) body.setVelocityY(speed);
    this.label.setText(`<NAME> — pos ${Math.round(body.x)}, ${Math.round(body.y)}`);
  }
}

new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: 800,
  height: 600,
  backgroundColor: '#1d1d1d',
  physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: [MainScene],
});
