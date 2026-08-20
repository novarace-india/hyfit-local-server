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

  /**
   * Where this event's public read is served from: 'online' or 'offline'.
   *
   * ASKED AT CREATION SINCE 093, and that is the change. It was a switch on the
   * Sync screen, which meant every event was born online and somebody had to
   * remember to go and flip it — and the symptom of forgetting is discovered at
   * a venue, by an operator whose pasted sync URL is refused because prod says
   * the event is online. It is a decision made when the event is planned, so it
   * is asked when the event is made.
   *
   * Absent means 'online', because that is what every event that exists today
   * is and a form that has not been updated must not silently move an event to
   * a laptop nobody has set up.
   */
  @IsOptional()
  @IsString()
  deliveryMode?: string;
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
