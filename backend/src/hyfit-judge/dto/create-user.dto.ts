import { IsString, Matches, IsOptional, IsIn } from 'class-validator';
import type { AppRole } from '../hjudge-session.util';

const validRoles: AppRole[] = [
  'super_admin',
  'event_admin',
  'checkin',
  'judge',
  'readonly',
];

export class CreateUserDto {
  @IsString()
  staffId!: string;

  @IsString()
  name!: string;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'PIN must be 4-8 digits' })
  pin!: string;

  @IsString()
  @IsIn(validRoles)
  role!: AppRole;

  @IsOptional()
  @IsString()
  eventId?: string;

  @IsOptional()
  stationNumber?: number;
}

export class UpdateUserDto {
  @IsString()
  id!: string;

  @IsOptional()
  enabled?: boolean;

  @IsOptional()
  stationNumber?: number;

  @IsOptional()
  @IsString()
  pin?: string;
}
