import sharp from 'sharp';
import decode from 'heic-decode';
import svgo from 'svgo';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { v4 as uuidv4 } from 'uuid';
import spawn from 'cross-spawn';
import tinycolor from 'tinycolor2';

export enum ColorMode {
  COLOR = 'color',
  BLACK_AND_WHITE = 'black-and-white',
}

// isLambda
// process.env.NODE_ENV === 'production' is not defined with claudiajs
// https://github.com/lucleray/tensorflow-lambda/blob/master/index.js#L10
// https://github.com/watson/is-lambda/blob/master/index.js
function isLambda() {
  const isVercel =
    process.env.NOW_REGION !== 'dev1' &&
    Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

  const isClaudia =
    process.env.LAMBDA_TASK_ROOT && process.env.AWS_EXECUTION_ENV;

  return process.platform === 'linux' && (isVercel || isClaudia);
}

export class KvecService {
  constructor() {}
  // ensure file type is image
  validateFileType(file: Express.Multer.File) {
    if (
      [
        'image/jpg',
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/gif',
        'image/svg+xml',
        'image/heic',
      ].includes(file.mimetype)
    ) {
      return file;
    } else {
      throw new UnsupportedMediaTypeException();
    }
  }

  // convert all images to png
  // resize png to max width or height of 1000
  async getPng(file: Express.Multer.File) {
    let image: sharp.Sharp;
    if (file.mimetype === 'image/heic') {
      // if heic, perform a manual conversion
      const {
        width, // integer width of the image
        height, // integer height of the image
        data, // ArrayBuffer containing decoded raw image data
      } = await decode({ buffer: file.buffer });

      // ArrayBuffer to Buffer https://stackoverflow.com/a/12101012
      image = await sharp(Buffer.from(data), {
        raw: { width, height, channels: 4 },
      });
    } else {
      // else, use sharp to convert the image to png
      image = await sharp(file.buffer);
    }

    const metadata = await image.metadata();

    const largestDimension =
      metadata.width > metadata.height ? 'width' : 'height';
    const ratio = 1000 / metadata[largestDimension];
    const dimensions = {
      width: Math.round(metadata.width * ratio),
      height: Math.round(metadata.height * ratio),
    };

    return image
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .resize(dimensions.width, dimensions.height, {
        withoutEnlargement: true,
        fit: 'cover',
      })
      .png()
      .toBuffer();
  }

  async getSvg(png: Buffer) {
    let tmpPath = isLambda()
      ? path.join(os.tmpdir(), 'images')
      : path.join(process.cwd(), 'dist', 'tmp', 'images');

    const id = uuidv4();
    const pngPath = path.join(tmpPath, `${id}.png`);
    const svgPath = path.join(tmpPath, `${id}.svg`);
    await fs.outputFile(pngPath, png);

    // lambda root https://stackoverflow.com/a/55422426
    // kvec will not recognize license file without commandPath
    let commandPath: string;
    let command: string;
    switch (os.platform()) {
      case 'darwin':
        commandPath = path.resolve('kvec/osx64/');
        command = './kvec';
        break;
      case 'win32':
        commandPath = path.resolve('kvec/win64/');
        command = './kvec.exe';
        break;
      case 'linux':
        commandPath = isLambda()
          ? path.join(process.env.LAMBDA_TASK_ROOT, 'kvec/lnx64/')
          : path.resolve('kvec/lnx64/');
        command = './kvec';
        break;
      default:
        throw new NotImplementedException();
    }

    const args = [
      pngPath,
      svgPath,
      '-format',
      'svg',
      '-bezier',
      '-grit',
      '100',
      '-smooth',
      'on',
      '-quantize',
      '2',
      '-overlap',
    ];

    const kvec = spawn(command, args, {
      /* stdio: 'inherit', */
      cwd: commandPath,
    });
    await new Promise((resolve, reject) => {
      kvec.on('close', (code) => {
        if (code !== 0) {
          // kvec does not implement success/error codes
          // reject(
          //   new Error(
          //     `${commandPath}/${command} ${args.join(
          //       ' ',
          //     )} failed with exit code ${code}. Please check your console.`,
          //   ),
          // );
          // return;
        }
        resolve(null);
      });
    });

    const svg = await fs.readFile(path.join(svgPath));
    await Promise.all([fs.remove(pngPath), fs.remove(svgPath)]);
    return svg
      .toString()
      .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  getMonochromeSvg(svg: string) {
    // get array of all unique hex colors
    // const regex = /rgb\(\d{1,3},\d{1,3},\d{1,3}\)/
    const regex = /#([a-f0-9]{3}){1,2}\b/gi;
    const matches = svg.match(regex);
    const colors = Array.from(new Set(matches));

    // calculate color brightness
    let brightnesses = colors.map((color) => ({
      color,
      brightness: tinycolor(color).getBrightness(),
    }));

    // if only one color, add white or black
    if (brightnesses.length === 1) {
      if (Math.round(brightnesses[0].brightness / 256) < 0.5) {
        brightnesses.push({
          color: '#FFF',
          brightness: 255,
        });
      } else {
        brightnesses.unshift({
          color: '#000',
          brightness: 0,
        });
      }
      // if >2 colors, convert to 2 colors
    } else if (brightnesses.length > 2) {
      brightnesses.sort((lumA, lumB) => lumA.brightness - lumB.brightness);
      // find lightest and darkest extremes to guarantee white and black
      const extremes = [brightnesses.shift(), brightnesses.pop()];
      // replace all other colors with white or black, whichever closest
      for (const brightness of brightnesses) {
        svg = svg.replaceAll(
          brightness.color,
          Math.round(brightness.brightness / 256) ? '#FFF' : '#000',
        );
      }
      brightnesses = extremes;
    }
    // replace lighter color with white,
    // and darker color with black
    return svg
      .replaceAll(
        brightnesses[0].color,
        brightnesses[0].color > brightnesses[1].color ? '#FFF' : '#000',
      )
      .replaceAll(
        brightnesses[1].color,
        brightnesses[1].color > brightnesses[0].color ? '#FFF' : '#000',
      );
  }

  async getOptimizedSvg(svg) {
    return (await svgo.optimize(svg)).data;
  }

  async getColorSvg(png) {
    let tmpPath = isLambda()
      ? path.join(os.tmpdir(), 'images')
      : path.join(process.cwd(), 'dist', 'tmp', 'images');

    const id = uuidv4();
    const pngPath = path.join(tmpPath, `${id}.png`);
    const svgPath = path.join(tmpPath, `${id}.svg`);
    await fs.outputFile(pngPath, png);

    // lambda root https://stackoverflow.com/a/55422426
    // kvec will not recognize license file without commandPath
    let commandPath;
    let command;
    switch (os.platform()) {
      case 'darwin':
        commandPath = path.resolve('kvec/osx64/');
        command = './kvec';
        break;
      case 'win32':
        commandPath = path.resolve('kvec/win64/');
        command = './kvec.exe';
        break;
      case 'linux':
        commandPath = isLambda()
          ? path.join(process.env.LAMBDA_TASK_ROOT, 'kvec/lnx64/')
          : path.resolve('kvec/lnx64/');
        command = './kvec';
        break;
      default:
        throw new NotImplementedException();
    }

    const args = [
      pngPath,
      svgPath,
      '-format',
      'svg',
      '-bezier',
      '-grit',
      '100',
      '-smooth',
      'on',
      '-overlap',
    ];

    const kvec = spawn(command, args, {
      /* stdio: 'inherit', */
      cwd: commandPath,
    });
    await new Promise((resolve, reject) => {
      kvec.on('close', (code) => {
        if (code !== 0) {
          // kvec does not implement success/error codes
          // reject(
          //   new Error(
          //     `${commandPath}/${command} ${args.join(
          //       ' ',
          //     )} failed with exit code ${code}. Please check your console.`,
          //   ),
          // );
          // return;
        }
        resolve(null);
      });
    });

    const svg = await fs.readFile(path.join(svgPath));
    await Promise.all([fs.remove(pngPath), fs.remove(svgPath)]);
    return svg
      .toString()
      .replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  async processFiles(files, colorMode) {
    return Promise.all(
      files.map((file, index) =>
        Promise.resolve(file)
          .then(this.validateFileType)
          .then(this.getPng)
          .then((input) => {
            switch (colorMode) {
              case ColorMode.COLOR:
                return Promise.resolve(input)
                  .then(this.getColorSvg)
                  .then(this.getOptimizedSvg);
              case ColorMode.BLACK_AND_WHITE:
                return Promise.resolve(input)
                  .then(this.getSvg)
                  .then(this.getOptimizedSvg)
                  .then(this.getMonochromeSvg);
            }
          })
          .then((file) => ({
            svg: file,
            fieldName: files[index].fieldname,
            originalName: files[index].originalname,
            mimeType: files[index].mimetype,
          })),
      ),
    );
  }
}
