import { IsString, Matches } from 'class-validator';

export class LoginDto {
  @IsString()
  staffId!: string;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4-8 digits' })
  pin!: string;

  @IsString()
  deviceLabel?: string;
}
