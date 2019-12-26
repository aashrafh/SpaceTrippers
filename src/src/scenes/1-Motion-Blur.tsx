import { Scene } from '../common/game';
import ShaderProgram from '../common/shader-program';
import Mesh from '../common/mesh';
import * as MeshUtils from '../common/mesh-utils';
import * as TextureUtils from '../common/texture-utils';
import Camera from '../common/camera';
import FlyCameraController from '../common/camera-controllers/fly-camera-controller';
import { vec3, mat4, quat } from 'gl-matrix';
import { CheckBox, Vector } from '../common/dom-utils';
import { createElement } from 'tsx-create-element';
// import { min } from 'gl-matrix/src/gl-matrix/vec2';
// import Object3D from '../common/object'
// This function creates a triangle wave, this is used to move the house model
function triangle(x: number): number {
    let i = Math.floor(x);
    return (i%2==0)?(x-i):(1+i-x);
}

// This is an interface for 3D object, you can think of it as C++ structs in this code (but they are generally different)
interface Object3D {
    mesh: Mesh; // which mesh to draw
    texture: WebGLTexture; // which texture to attach
    tint: [number, number, number, number], // the color tint of the object
    currentModelMatrix: mat4, // The model matrix of the object in the current frame
    previousModelMatrix: mat4 // The model matrix of the object in the previous frame
};

let Space_Displacement = -70;
let Space_Displacement2 = -70;
let Space_Displacement3 = -70;

let movementX = 0;
let movementY = 0;
let movementZ = 0;

let nubmerOfStones = 5;
let Stones_pos: number[][];

let Shuttle_X = 0;
let Shuttle_Y = 8;
let Shuttle_Z = -5;

// In this scene we will draw a scene to multiple targets then use the targets to do a motion blur post processing
export default class MotionBlurScene extends Scene {
    
    programs: { [name: string]: ShaderProgram } = {}; // This will hold all our shaders
    camera: Camera;
    controller: FlyCameraController;
    meshes: { [name: string]: Mesh } = {}; // This will hold all our meshes
    textures: { [name: string]: WebGLTexture } = {}; // This will hold all our textures
    samplers: { [name: string]: WebGLSampler } = {}; // This will hold all our samplers
    sampler: WebGLSampler;
    frameBuffer: WebGLFramebuffer; // This will hold the frame buffer object

    objects: {[name: string]: Object3D} = {}; // This will hold all our 3D objects
    VP_prev: mat4; // This will hold the ViewProjection matrix of the camera in the previous frame

    motionBlurEnabled: boolean = true; // Whether motion blur is enabled or not
    drawSky: boolean = true;

    time: number = 0; // The time in the scene
    paused: boolean = false; // Whether the time is paused or not

    static readonly cubemapDirections = ['negx', 'negy', 'negz', 'posx', 'posy', 'posz']
    cube: Mesh
    public load(): void {
        this.game.loader.load({
            ["mrt.vert"]: { url: 'shaders/mrt.vert', type: 'text' }, // A vertex shader for multi-render-target rendering
            ["mrt.frag"]: { url: 'shaders/mrt.frag', type: 'text' }, // A fragment shader for multi-render-target rendering
            ["fullscreen.vert"]: { url: 'shaders/post-process/fullscreen.vert', type: 'text' }, // The vertex shader for all fullscreen effects
            ["motion-blur.frag"]: { url: 'shaders/post-process/motion-blur.frag', type: 'text' }, // The motion blur fragment shader
            ["blit.frag"]: { url: 'shaders/post-process/blit.frag', type: 'text' }, // A fragment shader that copies one texture to the screen
            ["texture-cube.vert"]:{url:'shaders/texture-cube.vert', type:'text'},
            ["texture-cube.frag"]:{url:'shaders/texture-cube.frag', type:'text'},
            ["sky-cube.vert"]:{url:'shaders/sky-cube.vert', type:'text'},
            ["sky-cube.frag"]:{url:'shaders/sky-cube.frag', type:'text'},
            ["suzanne"]:{url:'models/Suzanne/Suzanne.obj', type:'text'},
            ["SpaceShuttle-model"]: { url: 'models/SpaceShuttle/SpaceShuttle.obj', type: 'text' },
            ["SpaceShuttle-texture"]: { url: 'models/SpaceShuttle/SpaceShuttle_BaseColor.png', type: 'image' },
            ["ground-texture"]: { url: 'models/Floor/bluegrid1.jpg', type: 'image' },
            // We will load all the 6 textures to create cubemap
            ...Object.fromEntries(MotionBlurScene.cubemapDirections.map(dir=>[dir, {url:`images/Sky/${dir}.jpg`, type:'image'}])),
            ["stone-model"]: { url: 'models/Stone/PUSHILIN_boulder.obj', type: 'text' },
            ["stone-texture"]: { url: 'models/Stone/PUSHILIN_boulder.png', type: 'image' }
        });
    }

    public start(): void {
        Stones_pos = new Array<Array<number>>();
        for(let i = 0; i < nubmerOfStones; i++)
        {
            let row:number[] = new Array<number>();
            for (let j = 0; j < 3; j++)
            {
                row.push(0);
            }            
            Stones_pos.push(row);
        }

        // This shader program will draw 3D objects into multiple render targets
        this.programs["3d"] = new ShaderProgram(this.gl);
        this.programs["3d"].attach(this.game.loader.resources["mrt.vert"], this.gl.VERTEX_SHADER);
        this.programs["3d"].attach(this.game.loader.resources["mrt.frag"], this.gl.FRAGMENT_SHADER);
        this.programs["3d"].link();

        // This shader will do motion blur
        this.programs["motion-blur"] = new ShaderProgram(this.gl);
        this.programs["motion-blur"].attach(this.game.loader.resources["fullscreen.vert"], this.gl.VERTEX_SHADER);
        this.programs["motion-blur"].attach(this.game.loader.resources["motion-blur.frag"], this.gl.FRAGMENT_SHADER);
        this.programs["motion-blur"].link();

        // This shader will just copy a texture to the screen
        this.programs["blit"] = new ShaderProgram(this.gl);
        this.programs["blit"].attach(this.game.loader.resources["fullscreen.vert"], this.gl.VERTEX_SHADER);
        this.programs["blit"].attach(this.game.loader.resources["blit.frag"], this.gl.FRAGMENT_SHADER);
        this.programs["blit"].link();

        this.programs['texture'] = new ShaderProgram(this.gl);
        this.programs['texture'].attach(this.game.loader.resources["texture-cube.vert"], this.gl.VERTEX_SHADER);
        this.programs['texture'].attach(this.game.loader.resources["texture-cube.frag"], this.gl.FRAGMENT_SHADER);
        this.programs['texture'].link();

        
        this.programs['sky'] = new ShaderProgram(this.gl);
        this.programs['sky'].attach(this.game.loader.resources["sky-cube.vert"], this.gl.VERTEX_SHADER);
        this.programs['sky'].attach(this.game.loader.resources["sky-cube.frag"], this.gl.FRAGMENT_SHADER);
        this.programs['sky'].link();
        

        // We load the 3D models here
        this.meshes['SpaceShuttle'] = MeshUtils.LoadOBJMesh(this.gl, this.game.loader.resources["SpaceShuttle-model"]);
        this.meshes['ground'] = MeshUtils.Plane(this.gl, {min: [0, 0], max: [20, 20]});
        this.meshes['groundTwo'] = MeshUtils.Plane(this.gl, {min: [0, 0], max: [20, 20]});
        this.meshes['groundThree'] = MeshUtils.Plane(this.gl, {min: [0, 0], max: [20, 20]});
        this.meshes['cube'] = MeshUtils.Cube(this.gl);
        // this.meshes['space'] = MeshUtils.Plane(this.gl, {min: [0, 0], max: [20, 20]})

        for (let i = 0; i < nubmerOfStones; i++)
        {
            this.meshes[i] = MeshUtils.LoadOBJMesh(this.gl, this.game.loader.resources["stone-model"]);
        }
        
        // These will be our 6 targets for loading the images to the texture
        const target_directions = [
            this.gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
            this.gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
            this.gl.TEXTURE_CUBE_MAP_NEGATIVE_Z,
            this.gl.TEXTURE_CUBE_MAP_POSITIVE_X,
            this.gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
            this.gl.TEXTURE_CUBE_MAP_POSITIVE_Z
        ]

        this.textures['environment'] = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_CUBE_MAP, this.textures['environment']); // Here, we will bind the texture to TEXTURE_CUBE_MAP since it will be a cubemap
        this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, 4);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false); // No need for UNPACK_FLIP_Y_WEBGL with cubemaps
        for(let i = 0; i < 6; i++){
            // The only difference between the call here and with normal 2D textures, is that the target is one of the 6 cubemap faces, instead of TEXTURE_2D
            this.gl.texImage2D(target_directions[i], 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.game.loader.resources[MotionBlurScene.cubemapDirections[i]]);
        }
        this.gl.generateMipmap(this.gl.TEXTURE_CUBE_MAP); // Then we generate the mipmaps


        // this.sampler = this.gl.createSampler();
        // // No need to specify wrapping since we will use directions instead of texture coordinates to sample from the texture.
        // this.gl.samplerParameteri(this.sampler, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        // this.gl.samplerParameteri(this.sampler, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);


        // Load the Space Shuttle texture
        this.textures['SpaceShuttle'] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['SpaceShuttle-texture']);
        for (let i = 0; i < 10; i++)
        {
            this.textures[i] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['stone-texture']);
        }
        //Load the Ground texture
        this.textures['ground'] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['ground-texture']);
        this.textures['groundTwo'] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['ground-texture']);
        this.textures['groundThree'] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['ground-texture']);
        //Load the space texture
        // this.textures['space'] = TextureUtils.LoadImage(this.gl, this.game.loader.resources['space-texture']);


        // Now we will create 3 texture to render our scene to.
        // The color target will hold the scene colors
        this.textures['color-target'] = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['color-target']);
        this.gl.texStorage2D(this.gl.TEXTURE_2D, 1, this.gl.RGBA8, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);

        // The motion target will hold the scene motion vectors
        this.gl.getExtension('EXT_color_buffer_float'); // Tell WebGL2 that we need to draw on Floating Point Textures
        this.textures['motion-target'] = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['motion-target']);
        this.gl.texStorage2D(this.gl.TEXTURE_2D, 1, this.gl.RGBA32F, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);

        // The depth target will hold the scene depth
        this.textures['depth-target'] = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['depth-target']);
        this.gl.texStorage2D(this.gl.TEXTURE_2D, 1, this.gl.DEPTH_COMPONENT32F, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight);

        // Now we create a frame buffer and attach our 3 target textures to it.
        this.frameBuffer = this.gl.createFramebuffer();
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.frameBuffer);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.textures['color-target'], 0);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT1, this.gl.TEXTURE_2D, this.textures['motion-target'], 0);
        this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.DEPTH_ATTACHMENT, this.gl.TEXTURE_2D, this.textures['depth-target'], 0);

        // Check if the frame buffer is working
        let status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
        if (status != this.gl.FRAMEBUFFER_COMPLETE) {
            if (status == this.gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT)
                console.error("The framebuffer has a type mismatch");
            else if (status == this.gl.FRAMEBUFFER_INCOMPLETE_MISSING_ATTACHMENT)
                console.error("The framebuffer is missing an attachment");
            else if (status == this.gl.FRAMEBUFFER_INCOMPLETE_DIMENSIONS)
                console.error("The framebuffer has dimension mismatch");
            else if (status == this.gl.FRAMEBUFFER_UNSUPPORTED)
                console.error("The framebuffer has an attachment with unsupported format");
            else if (status == this.gl.FRAMEBUFFER_INCOMPLETE_MULTISAMPLE)
                console.error("The framebuffer has multisample mismatch");
            else
                console.error("The framebuffer has an unknown error");
        }

        // Create a regular sampler for textures rendered on the scene objects
        this.samplers['regular'] = this.gl.createSampler();
        this.gl.samplerParameteri(this.samplers['regular'], this.gl.TEXTURE_WRAP_S, this.gl.REPEAT);
        this.gl.samplerParameteri(this.samplers['regular'], this.gl.TEXTURE_WRAP_T, this.gl.REPEAT);
        this.gl.samplerParameteri(this.samplers['regular'], this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.samplerParameteri(this.samplers['regular'], this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);

        // Create a regular sampler for textures rendered fullscreen using post-processing
        this.samplers['postprocess'] = this.gl.createSampler();
        this.gl.samplerParameteri(this.samplers['postprocess'], this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
        this.gl.samplerParameteri(this.samplers['postprocess'], this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
        this.gl.samplerParameteri(this.samplers['postprocess'], this.gl.TEXTURE_MAG_FILTER, this.gl.NEAREST);
        this.gl.samplerParameteri(this.samplers['postprocess'], this.gl.TEXTURE_MIN_FILTER, this.gl.NEAREST);

        //create environment
        this.samplers['sky-sampler'] = this.gl.createSampler();
        this.gl.samplerParameteri(this.samplers['sky-sampler'], this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.samplerParameteri(this.samplers['sky-sampler'], this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR_MIPMAP_LINEAR);
        // Create a camera and a controller for it
        this.camera = new Camera();
        this.camera.type = 'perspective';
        this.camera.position = vec3.fromValues(30, 30, 30);
        this.camera.direction = vec3.fromValues(-1, -1, -1);
        this.camera.aspectRatio = this.gl.drawingBufferWidth / this.gl.drawingBufferHeight;
        this.controller = new FlyCameraController(this.camera, this.game.input);
        this.controller.movementSensitivity = 0.01;
        this.controller.fastMovementSensitivity = 0.1; // If you press Shift, the camera will move 10x faster

        // Enable backface culling
        this.gl.enable(this.gl.CULL_FACE);
        this.gl.cullFace(this.gl.BACK);
        this.gl.frontFace(this.gl.CCW);
        // Enable depth testing
        this.gl.enable(this.gl.DEPTH_TEST);
        this.gl.depthFunc(this.gl.LEQUAL);

        // Now we create the 3D objects: a SpaceShuttle, a ground, a space
        this.objects['SpaceShuttle'] = {
            mesh: this.meshes['SpaceShuttle'],
            texture: this.textures['SpaceShuttle'],
            tint: [1,1,1,1],
            currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), -90, 45, 0), vec3.fromValues(Shuttle_X, Shuttle_Y, Shuttle_Z), vec3.fromValues(1, 1, 1)),
            previousModelMatrix: mat4.create()
        };
        for (let i = 0; i < nubmerOfStones; i++)
        {   
            Stones_pos[i][0] = Math.random() * 100 - 80 - 40 * i;
            Stones_pos[i][1] = 15;
            Stones_pos[i][2] = Math.random() * 100 - 80 - 40 * i;
            this.objects[i] = {
                mesh: this.meshes[i],
                texture: this.textures[i],
                tint: [1,1,1,1],
                currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 0, 0), vec3.fromValues(Stones_pos[i][0], Stones_pos[i][1], Stones_pos[i][2]), vec3.fromValues(10, 10, 10)),
                previousModelMatrix: mat4.create()
            };
        }
        // this.objects[i] = {
        //     mesh: this.meshes[i],
        //     texture: this.textures[i],
        //     tint: [1,1,1,1],
        //     currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 0, 0), vec3.fromValues(Stones_pos[i][0], Stones_pos[i][1], Stones_pos[i][2]), vec3.fromValues(10, 10, 10)),
        //     previousModelMatrix: mat4.create()
        // };
        this.objects['ground'] = {
            mesh: this.meshes['ground'],
            texture: this.textures['ground'],
            tint: [1,1,1,1],
            currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 45, 0), vec3.fromValues(0, 0, 0), vec3.fromValues(100, 1, 100)),
            previousModelMatrix: mat4.create()
        };
        this.objects['groundTwo'] = {
            mesh: this.meshes['groundTwo'],
            texture: this.textures['groundTwo'],
            tint: [1,1,1,1],
            currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 45, 0), vec3.fromValues(0, 0, 0), vec3.fromValues(100, 1, 100)),
            previousModelMatrix: mat4.create()
        };
        // this.objects['space'] = {
        //     mesh: this.meshes['space'],
        //     texture: this.textures['space'],
        //     tint: [1,1,1,1],
        //     currentModelMatrix: mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 45, 0), vec3.fromValues(0, 0, 0), vec3.fromValues(100, 1, 100)),
        //     previousModelMatrix: mat4.create()
        // };
       
        
        // this.gl.enable(this.gl.CULL_FACE);
        // this.gl.cullFace(this.gl.BACK);
        // this.gl.frontFace(this.gl.CCW);

        // this.gl.enable(this.gl.DEPTH_TEST);
        // this.gl.depthFunc(this.gl.LEQUAL);

        // this.gl.clearColor(0,0,0,1);
        this.setupControls();
    }

    public draw(deltaTime: number): void {
        // Before updating the camera controller, We stor the old VP matrix to be used in motion blur
        this.VP_prev = this.camera.ViewProjectionMatrix;
        this.controller.update(deltaTime); // then we update the camera controller

        if(!this.paused){ // If paused, we will skip updating time and the matrices
            this.time += deltaTime; // Update time
            for(let key in this.objects){ // Before calculating new model matrices, we store the previous model matrices
                let obj = this.objects[key];
                obj.previousModelMatrix = obj.currentModelMatrix;
            }

         // this.objects['SpaceShuttle'].currentModelMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), -90, 0, 0), vec3.fromValues(movementX%20, movementY%20, movementZ%20), vec3.fromValues(1, 1, 1));
        }


        if(this.game.input.isButtonDown(0)){

            if(this.game.input.isKeyDown("i")) movementY += 1;
            if(this.game.input.isKeyDown("k")) movementY -= 1;
            if(this.game.input.isKeyDown("l")) movementX += 1;
            if(this.game.input.isKeyDown("j")) movementX -= 1;
            movementX = Math.max(-40, movementX);
            movementX = Math.min(40, movementX);
            movementY = Math.max(0, movementX);
            movementY = Math.min(40, movementX);
            // if(this.game.input.isKeyDown("u")) movementZ += 1;
            // if(this.game.input.isKeyDown("o")) movementZ -= 1;
        }

        //movementY + 20*triangle(this.time/1000)
        // Now we update the matrices
        Space_Displacement += 4;
        Space_Displacement2 += 4;

        if (Space_Displacement >= 204) Space_Displacement = -50;
        if (Space_Displacement2 >= 100) Space_Displacement2 = -70;

        this.objects['ground'].currentModelMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 45, 0), vec3.fromValues(Space_Displacement, 0 , Space_Displacement), vec3.fromValues(100, 1, 600))
        this.objects['groundTwo'].currentModelMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 45, 0), vec3.fromValues(-90 + Space_Displacement, 0 , -90 + Space_Displacement), vec3.fromValues(100, 1, 600));
        this.objects['SpaceShuttle'].currentModelMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), -90, 45, 0), vec3.fromValues(movementX, 10,-movementX), vec3.fromValues(1, 1, 1));

        for (let i = 0; i < nubmerOfStones; i++)
        {
            if (Stones_pos[i][0] > 70 || Stones_pos[i][2] > 70)
            {
                Stones_pos[i][0] = Math.random() * 100 - 80 - 40 * i;
                Stones_pos[i][1] = 15;
                Stones_pos[i][2] = Math.random() * 100 - 80 - 40 * i;
            } 

            Stones_pos[i][0]++, Stones_pos[i][2]++;
            this.objects[i].currentModelMatrix = mat4.fromRotationTranslationScale(mat4.create(), quat.fromEuler(quat.create(), 0, 0, 0), vec3.fromValues(Stones_pos[i][0], Stones_pos[i][1], Stones_pos[i][2]), vec3.fromValues(10, 10, 10));
        }


        ////// Collision //////
        for (let i = 0; i < nubmerOfStones; i++)
        {
            if (Stones_pos[i][0] + 12 > Shuttle_X)
            {
                if (Stones_pos[i][1]  > Shuttle_Y)
                {
                    if (Stones_pos[i][2] + 20 > Shuttle_Z)
                    {
                        Stones_pos[i][0] = Math.random() * 100 - 80 - 40 * i;
                        Stones_pos[i][1] = 15; 
                        Stones_pos[i][2] = Math.random() * 100 - 80 - 40 * i;
                    }
                }
            }
            
        }
        //5 * triangle(this.time/1000)
        // for (let i = 0; i < nubmerOfStones; i++)
        // {
        //     if (Math.abs(Stones_pos[i][0] - Shuttle_X) <= (22.39 + 1.32) - 13)
        //     {
        //         if (Math.abs(Stones_pos[i][1] - Shuttle_Y) <= (39.20 + 1.34) - 13)
        //         {
        //             if (Math.abs(Stones_pos[i][2] - Shuttle_Z) <= (17.92 + 1.40) - 13)
        //             {
        //                 Stones_pos[i][0] = Math.random() * 100 - 80 - 40 * i;
        //                 Stones_pos[i][1] = 15; 
        //                 Stones_pos[i][2] = Math.random() * 100 - 80 - 40 * i;
        //             }
        //         }
        //     }
            
        // }
        // y = 16, z = 40, x = 20


        // To start drawing the scene, we bind our frame buffer
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.frameBuffer);
        {
            this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight); // Ensure that the viewport covers the whole framebuffer
            this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0, this.gl.COLOR_ATTACHMENT1]); // Then we tell WebGL that both of those attachments will have an output from the fragment shader
            this.gl.clearBufferfv(this.gl.COLOR, 0, [0.88, 0.65, 0.15, 1]); // Clear the color target
            this.gl.clearBufferfv(this.gl.COLOR, 1, [0, 0, 0, 1]); // Clear the motion target
            this.gl.clearBufferfi(this.gl.DEPTH_STENCIL, 0, 1, 0); // Clear the depth target

            let program = this.programs['3d']; // Now, we use the MRT shader to render the scene into multiple render targets
            program.use();

            program.setUniformMatrix4fv("VP", false, this.camera.ViewProjectionMatrix); // Send the View Projection matrix

            // For each object, setup the shader uniforms then draw
            for(let key in this.objects){
                let obj = this.objects[key];
                //TODO: Add any uniforms you need here
                program.setUniformMatrix4fv("M", false, obj.currentModelMatrix); // Send the model matrix of the object in the current frame
                program.setUniformMatrix4fv("PrevM", false, obj.previousModelMatrix); // Send the model matrix of the object in the previous frame
                
                program.setUniform4f("tint", obj.tint); // Send the color tint
                this.gl.activeTexture(this.gl.TEXTURE0); // Bind the texture and sampler to unit 0
                this.gl.bindTexture(this.gl.TEXTURE_2D, obj.texture);
                program.setUniform1i('texture_sampler', 0);
                this.gl.bindSampler(0, this.samplers['regular']);
                obj.mesh.draw(this.gl.TRIANGLES); // Draw the object mesh
            }
        }

        // Now we go back to the default framebuffer (the canvas frame buffer)

        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        {
            this.gl.viewport(0, 0, this.gl.drawingBufferWidth, this.gl.drawingBufferHeight); // Ensure that the viewport covers the whole canvas
            this.gl.clearColor(0, 0, 0, 1); // Set a black clear color (not important since it will be overwritten)
            this.gl.clear(this.gl.COLOR_BUFFER_BIT | this.gl.DEPTH_BUFFER_BIT); // Clear the color and depth of the canvas

            if(this.motionBlurEnabled){ // If motion blur is enabled, draw fullscreen using the motion blur shader
                let program = this.programs['motion-blur'];
                program.use();
                program.setUniformMatrix4fv('P_i', false, mat4.invert(mat4.create(), this.camera.ViewProjectionMatrix));
                program.setUniformMatrix4fv('prevVP', false, this.VP_prev);
                this.gl.activeTexture(this.gl.TEXTURE0);
                this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['color-target']);
                program.setUniform1i('color_sampler', 0);
                this.gl.bindSampler(0, this.samplers['postprocess']);
                this.gl.activeTexture(this.gl.TEXTURE1);
                this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['depth-target']);
                program.setUniform1i('depth_sampler', 1);
                this.gl.bindSampler(1, this.samplers['postprocess']);
                this.gl.activeTexture(this.gl.TEXTURE2);
                this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['motion-target']);
                program.setUniform1i('motion_sampler', 2);
                this.gl.bindSampler(2, this.samplers['postprocess']);
                this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
            } else { // If motion blur is disabled, we just blit the color target to full screen
                let program = this.programs['blit'];
                program.use();
                this.gl.activeTexture(this.gl.TEXTURE0);
                this.gl.bindTexture(this.gl.TEXTURE_2D, this.textures['color-target']);
                program.setUniform1i('color_sampler', 0);
                this.gl.drawArrays(this.gl.TRIANGLES, 0, 4);
            }
        }
        
        
        this.gl.cullFace(this.gl.FRONT);
        this.gl.depthMask(false);

        this.programs['sky'].use();

        this.programs['sky'].setUniformMatrix4fv("VP", false, this.camera.ViewProjectionMatrix);
        this.programs['sky'].setUniform3f("cam_position", this.camera.position);

        let skyMat = mat4.create();
        mat4.translate(skyMat, skyMat, this.camera.position);
        
        this.programs['sky'].setUniformMatrix4fv("M", false, skyMat);

        this.programs['sky'].setUniform4f("tint", [1, 1, 1, 1]);

        this.gl.activeTexture(this.gl.TEXTURE0);
        this.gl.bindTexture(this.gl.TEXTURE_CUBE_MAP, this.textures['environment']);
        this.programs['sky'].setUniform1i('cube_texture_sampler', 0);
        this.gl.bindSampler(0, this.sampler);

        this.meshes['cube'].draw(this.gl.TRIANGLES);
        
        this.gl.cullFace(this.gl.BACK);
        this.gl.depthMask(true);
        
    }

    public end(): void {
        // Clean memory
        for (let key in this.programs)
            this.programs[key].dispose();
        this.programs = {};
        for (let key in this.meshes)
            this.meshes[key].dispose();
        this.meshes = {};
        this.gl.deleteFramebuffer(this.frameBuffer);
        for (let key in this.textures)
            this.gl.deleteTexture(this.textures[key]);
        this.textures = {};
        this.clearControls();
        this.cube.dispose();
        this.cube = null;
    }


    /////////////////////////////////////////////////////////
    ////// ADD CONTROL TO THE WEBPAGE (NOT IMPORTNANT) //////
    /////////////////////////////////////////////////////////
    private setupControls() {
        const controls = document.querySelector('#controls');

        controls.appendChild(
            <div>
                <div className="control-row">
                    <CheckBox value={this.motionBlurEnabled} onchange={(v)=>{this.motionBlurEnabled = v;}}/>
                    <label className="control-label">Enable Motion Blur</label>
                </div>
                <div className="control-row">
                    <CheckBox value={this.paused} onchange={(v)=>{this.paused = v;}}/>
                    <label className="control-label">Pause</label>
                </div>
            </div>

        );

    }

    private clearControls() {
        const controls = document.querySelector('#controls');
        controls.innerHTML = "";
    }


}