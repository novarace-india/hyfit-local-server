import { IsString, IsOptional } from 'class-validator';

export class CreateEventDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  venue?: string;

  @IsOptional()
  startsAt?: string;

  @IsOptional()
  endsAt?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}

export class UpdateEventDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  venue?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  activate?: boolean;
}
