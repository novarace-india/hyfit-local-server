# HYFIT Games Frontend

Frontend implementation of the HYFIT Games athlete platform, built with Next.js 13+ (App Router) and Tailwind CSS.

## Overview

This frontend provides the athlete-facing interface for the HYFIT Games platform, mirroring the functionality of the original standalone Express + Postgres application but now integrated into the Novarace platform.

## Architecture

### Tech Stack
- **Framework**: Next.js 13+ (App Router)
- **Styling**: Tailwind CSS
- **State Management**: React Hooks (useState, useEffect)
- **Data Fetching**: Custom API client (`/lib/api.ts`)
- **Authentication**: Bearer token JWT (stored in localStorage)
- **UI Components**: Custom reusable components in `/lib/ui.tsx`

### Key Directories
```
/app/(hyfitgames)/
├── hyfitgames/                 # Main HYFIT Games section
│   ├── (app)/                    # Athlete dashboard routes (protected)
│   │   ├── events/[id]/          # Event details
│   │   ├── events/[id]/leaderboard   # Event leaderboard
│   │   ├── events/[id]/scorecard/[regId]  # Individual scorecard
│   │   ├── my-stats/             # Athlete performance dashboard
│   │   ├── profile/              # Profile editor
│   │   ├── history/              # Past events history
│   │   ├── results/[regId]/      # Detailed results for a registration
│   │   ├── login/                # Login page
│   │   └── layout.tsx            # Athlete layout with bottom nav
│   ├── admin/                    # Admin routes (protected)
│   ├── lib/                      # Shared utilities
│   │   ├── api.ts                # API client with auth handling
│   │   └── ui.tsx                # Reusable UI components
│   ├── hfg.css                   # Custom styles
│   └── layout.tsx                # Root layout
```

## Key Features

### Authentication Flow
1. **Mobile Entry**: User enters their 10-digit mobile number
2. **OTP Request**: System sends 6-digit OTP to the mobile number
3. **OTP Verification**: User enters the OTP to authenticate
4. **Token Storage**: Access and refresh tokens stored in localStorage
5. **Automatic Refresh**: Token refresh handled transparently by API client

### Athlete Dashboard (`/hyfitgames`)
- Welcome message with first name
- Next upcoming race or "Happening now" indicator
- Profile completion reminder
- Navigation to My Stats

### Profile Management (`/hyfitgames/profile`)
- Personal details editing (name, email, DOB, location)
- Emergency contact information
- Physical attributes (gender, blood group, t-shirt size)
- Profile completion tracking
- Logout functionality

### Event Hub (`/hyfitgames/events/[id]`)
- Event information (name, date, venue, status)
- Athlete's personal race information (bib, wave, start time) if registered
- Links to leaderboard and results
- Course/station listing
- Event announcements

### Leaderboard (`/hyfitgames/events/[id]/leaderboard`)
- Filterable by gender, age group, category, search
- Pagination controls (configurable limit)
- Real-time status indicators (Live, Provisional, Final)
- Detailed athlete information (name, bib, status, splits, etc.)

### My results (`/hyfitgames/events/[id]/results`)
Scoped to the logged-in athlete — **not** the whole field. The full field is the
Leaderboard, linked from the foot of the page.
- One card per category the athlete entered (`UNIQUE (event_id, athlete_id, category)`
  means at most one entry each, so there is nothing to rank or filter here)
- A doubles entry shows BOTH results the pair owns: the team's placing and time as
  the headline, each member's own leg and category rank beneath it
- Placings carry their field size ("#3 of 24"), counted server-side since the page
  no longer holds the field to derive it from
- A doubles entry with no partner recorded is flagged — it is ranked among
  individuals, not teams. A pair is identified by its **club**: two entries in one
  doubles category with the same club are the team (migration 065), so an entry
  with no club, or the only one from its club, has no partner recorded
- Served by `GET /me/events/[id]/results`, a separate authenticated route rather
  than a flag on the public one, whose response is cached under an event-scoped key

### Scorecard (`/hyfitgames/events/[id]/scorecard/[regId]`)
- Comprehensive individual race breakdown
- Station-by-station splits with cumulative times
- Station rankings and averages
- Event winner information
- Participation statistics

### My Stats (`/hyfitgames/my-stats`)
- Performance dashboard with:
  - Total events, finishes, DNFs, DNSs
  - Personal best time and best rank
  - Win/podium/top-10 counts
  - Average rank and time
  - Cities visited
- Performance breakdowns:
  - City-wise performance
  - Station-by-station performance trends
  - Monthly performance trends
  - Event progression over time
  - Percentile rankings
  - Consistency metrics (standard deviation)
  - Streak tracking (current and longest finish streaks)
  - Gender-based performance

### Results Detail (`/hyfitgames/results/[regId]`)
- Detailed registration information
- Chronological split times with cumulative timing
- Protest submission interface (when applicable)
- Event details and status

## API Integration

The frontend communicates with the backend through `/api/hyfitgames` endpoints using a custom API client that:

1. **Handles Authentication**: Automatically attaches JWT tokens to requests
2. **Manages Token Refresh**: Transparently refreshes expired access tokens
3. **Handles Response Format**: Unwraps the Novarace standard response format
4. **Provides Redirect Handling**: Automatically redirects to login on session expiry
5. **Supports Role-Based Requests**: Separate token storage for athlete vs admin

### Key API Endpoints Used
- `GET /me` - Athlete profile information
- `GET /me/events` - Athlete's event registrations
- `GET /me/events/[id]/results` - The athlete's OWN results at one event (auth'd, uncached)
- `GET /me/stats` - Athlete performance statistics
- `PATCH /me` - Profile updates
- `GET /events/[id]` - Event details
- `GET /events/[id]/leaderboard` - Event leaderboard with filtering
- `GET /events/[id]/results` - Full-field event results (public, cached; used by the admin console)
- `GET /events/[id]/scorecard/[regId]` - Individual scorecard
- `GET /events/[id]/registrations/[regId]/certificate` - Certificate PDF
- `POST /auth/otp/request` - Request OTP
- `POST /auth/otp/verify` - Verify OTP and login
- `POST /auth/refresh` - Refresh access token
- `POST /auth/logout` - Logout
- `POST /auth/admin/login` - Admin login
- `POST /me/registrations/[regId]/protest` - Submit protest

## UI Components

### Shared Components (`/lib/ui.tsx`)
- **Spinner**: Loading indicator
- **ErrorNote**: Error message display
- **Chip**: Status indicators (Live, Provisional, Final, Finisher, DNF, etc.)
- **Empty**: Empty state component
- **SectionTitle**: Section heading component

### Styling Approach
- **Tailwind CSS**: Utility-first CSS framework
- **Custom CSS**: `/app/(hyfitgames)/hyfitgames/hfg.css` for component-specific styles
- **Responsive Design**: Mobile-first approach with breakpoint-specific utilities
- **Dark Mode Support**: Built-in Tailwind dark mode support (via class strategy)

## Security Features

- **Token Storage**: HttpOnly cookies not used; tokens stored in localStorage with careful XSS protection
- **Token Refresh**: Automatic silent refresh of access tokens using refresh tokens
- **Route Protection**: Client-side route protection via `useRequireAthlete` hook
- **API Protection**: Server-side validation on all endpoints
- **Input Sanitization**: Form input validation and sanitization
- **Secure OTP**: Rate-limited OTP sending with exponential backoff

## Performance Optimizations

- **Client-Side Caching**: API client caches recent requests where appropriate
- **Optimistic Updates**: Immediate UI updates for positive user experience
- **Lazy Loading**: Images and non-critical resources loaded on demand
- **Code Splitting**: Automatic route-based code splitting via Next.js
- **Efficient Data Fetching**: Parallel requests where possible using Promise.all()

## Development

### Setup
1. Install dependencies: `npm install`
2. Run development server: `npm run dev`
3. Build for production: `npm run build`
4. Start production server: `npm run start`

### Environment Variables
The frontend relies on the Next.js environment variables for configuration:
- API base path is automatically handled by Next.js rewrites
- No additional configuration typically required

### Testing
- Component-level testing with React Testing Library
- End-to-end testing with Cypress (if configured)
- Manual testing across devices and screen sizes

## Deployment
The frontend is built as part of the Next.js application and served by the Node.js server. It integrates seamlessly with the backend Next.js API routes.

## Architecture Decisions

### Why Next.js App Router?
- Improved data fetching with Server Components and Server Actions
- Simplified routing with file-system based routing
- Built-in loading and error states
- Better SEO capabilities
- Streamlined API route handling

### Why Tailwind CSS?
- Rapid UI development with utility-first approach
- Consistent design system
- Excellent responsiveness controls
- Minimal CSS bundle size
- Easy theme customization

### Why Custom API Client?
- Centralized authentication handling
- Consistent error handling
- Automatic token refresh logic
- Response format normalization
- Easy mocking for testing

## Future Enhancements

1. **Offline Support**: Service worker for basic offline functionality
2. **Push Notifications**: Race day notifications and results alerts
3. **Advanced Analytics**: Deeper performance analytics and comparisons
4. **Social Features**: Friend tracking and competition features
5. **Multi-language Support**: Internationalization for global events
6. **Accessibility Improvements**: Enhanced WCAG compliance
7. **Performance Monitoring**: Real-time performance metrics and bottleneck identification

## Integration with Backend

The frontend is designed to work specifically with the HYFIT Games backend module:
- Expects API endpoints under `/api/hyfitgames`
- Relies on the backend's authentication system
- Uses the same database schema through the API
- Benefits from backend caching mechanisms
- Inherits backend security measures (rate limiting, input validation, etc.)

## Troubleshooting

### Common Issues
1. **Authentication Loops**: Check localStorage for expired tokens
2. **API Errors**: Verify backend is running and accessible
3. **Stale Data**: Hard refresh or clear localStorage for auth tokens
4. **UI Issues**: Check browser console for React errors
5. **Performance Problems**: Check network tab for slow API requests

### Debugging
- Enable API logging in `/lib/api.ts` for request/response inspection
- Use React DevTools for component state inspection
- Check Network tab for API call timing and payloads
- Review console for warnings and errors