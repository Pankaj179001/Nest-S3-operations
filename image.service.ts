import { Injectable } from '@nestjs/common';
import * as S3 from 'aws-sdk/clients/s3';
import * as message from 'aws-sdk/lib/maintenance_mode_message.js';
import * as sharp from 'sharp';
message.suppress = true; //to remove js migrate warning----
import * as random from 'rand-token';
import {
  RelationError,
  errfunction,
} from '../Common/HelperFunctions/ErrorFunction';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient, entity } from '@prisma/client';
import { S3Folders } from '../Common/Constants';
const prisma = new PrismaClient();

type AssetCreateArg1 = {
  image: string;
  cover?: boolean;
  type: string;
  entity: entity;
};

type AssetCreateArg2 = {
  entity_assets: any;
  businessId: number;
  parent: number;
};
type CopyObject = {
  filename: string;
  folder: S3Folders;
  copythumbnail: boolean;
};

@Injectable()
export class UploadService {
  constructor(private readonly events: EventEmitter2) {}
  // executed = false;
  AWS_S3_BUCKET = process.env.AWS_S3_BUCKET;
  s3 = new S3({
    region: process.env.AWS_BUCKET_REGION,
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: true,
    // logger: console,
  });

  //upload Images-----------------
  async uploadFile(folder: string, file: Express.Multer.File) {
    // console.log(file);
    const trimName = random.generate(4);
    const extension = file?.mimetype?.split('/')[1];
    const filename =
      `${Date.now()}-${trimName}` + `.${extension}`.replace(/\s/g, '');
    const fileExtension = file.mimetype.split('/')[1];
    const validFiles = ['jpg', 'jpeg', 'png', 'webp'];
    const con = validFiles?.some((el) => fileExtension.includes(el));
    if (!con) {
      const msg = 'please upload file with jpg, jpeg, png  extension';
      return errfunction(msg, 415);
    }
    return await this.s3_upload(
      file.buffer,
      this.AWS_S3_BUCKET,
      folder,
      filename,
      extension,
    ).then((data: any) => data.Location);
  }

  //s3 upload function---------------
  async s3_upload(
    file: Buffer,
    bucket: string,
    folder,
    name: string,
    mimetype: string,
  ) {
    try {
      const params = {
        Bucket: bucket,
        Key: String(folder + '/' + name),
        Body: file,
        ACL: 'public-read',
        ContentType: mimetype,
        ContentDisposition: 'inline',
        CreateBucketConfiguration: {
          LocationConstraint: process.env.AWS_BUCKET_REGION,
        },
      };
      const s3Response = await this.s3
        .upload(params)
        .promise()
        .catch((e) => console.log(e));

      const Key = folder + '/' + name;
      const param = { Bucket: bucket, Key }; //create image with dimention w=100-----------
      const format = mimetype?.split('/')[1] || mimetype;
      const rqstImg = `${name.split('.')[0] + 100 + 'x' + 100}.${format}`;
      //prevent user to not enter scope for second time in if statement----------------
      if (!rqstImg.includes('100x100100x100')) {
        this.s3.getObject(param, async (err, data) => {
          if (err?.statusCode == 404) {
          } else if (!err) {
            const { Body, ContentType: contnt } = data;
            // console.log(format);
            const resizedBfr: any = await sharp(Body as Buffer)
              .resize({ width: Number(100), fit: 'contain' })
              .toFormat(format as any, { quality: 100 })
              .toBuffer()
              .catch(() => {
                return;
              });
            // console.log(rqstImg, folder, format);
            if (Boolean(resizedBfr)) {
              const ImgBfr = Buffer.from(resizedBfr);
              await this.s3_upload(ImgBfr, bucket, folder, rqstImg, contnt);
              return;
            }
            return;
          } else {
            return;
          }
        });
      }
      return s3Response;
    } catch (e) {
      console.log({ e });
      // errfunction(e);
    }
  }

  //Delete s3 Image---------------
  async deleteImg(image: string, thumbnail?: any) {
    try {
      const Key = image?.split('/')?.slice(-2).join('/');
      const params = { Bucket: this.AWS_S3_BUCKET, Key };
      const ext = image?.split('.')?.pop();
      // console.log(ext, params);
      if (Key) {
        await this.s3.deleteObject(params).promise();
        params['Key'] = `${params?.Key?.split('.')[0]}100x100.${ext}`;
        // console.log(params?.Key);
        await this.s3.deleteObject(params).promise();
        // .then((data) => console.log({ data }));
        this.events.emit('delete.Assets', thumbnail);
      }
      return `'${image}' deleted successfully`;
    } catch (error) {
      errfunction(error);
    }
  }

  async AssetCreate(arg1: AssetCreateArg1, arg2: AssetCreateArg2) {
    try {
      const { image, cover, type, entity: entity_type } = arg1;
      const { entity_assets, businessId, parent } = arg2;
      const name = image?.split('/');
      const Org = name.pop()?.split('.');
      const thumbnail = name.join('/') + '/' + Org[0] + '100x100.' + Org[1];
      const create = { image_url: image, thumbnail_url: thumbnail, cover };
      const data = {
        name: image,
        type,
        entity_type,
        entity_id: parent,
        thumbnail: { create },
        entity_assets,
        businessId,
      };

      await prisma.assets.create({ data });
    } catch (error) {
      RelationError(error);
    }
  }

  async CopyObject(CopyObject: CopyObject) {
    try {
      const { filename, folder } = CopyObject;
      const srcFilename = folder + filename.split(folder).pop();
      const trimName = random.generate(4);
      const extension = srcFilename.split('.').pop();
      const destFilename =
        `${Date.now()}-${trimName}` + `.${extension}`.replace(/\s/g, '');
      const params = {
        Bucket: this.AWS_S3_BUCKET,
        CopySource: `${this.AWS_S3_BUCKET}/${srcFilename}`,
        Key: folder + '/' + destFilename,
      };
      this.s3.copyObject(params, function (err, data) {
        if (err) console.log(err, err.stack); // an error occurred
        else return data; // successful response
      }).promise;
      //also copying thumbnail images
      if (CopyObject.copythumbnail) {
        const thumbnailImg = srcFilename.split('.').join('100x100.');
        const Thumbnaildest = destFilename.split('.').join('100x100.');
        const params = {
          Bucket: this.AWS_S3_BUCKET,
          CopySource: `${this.AWS_S3_BUCKET}/${thumbnailImg}`,
          Key: folder + '/' + Thumbnaildest,
        };
        this.s3.copyObject(params, function (err, data) {
          if (err) console.log(err, err.stack); // an error occurred
          else return data; // successful response
        }).promise;
      }
      const location = `https://${this.AWS_S3_BUCKET}.s3.amazonaws.com/${folder}/${destFilename}`;
      return location;
    } catch (error) {
      errfunction(error);
    }
  }
}
