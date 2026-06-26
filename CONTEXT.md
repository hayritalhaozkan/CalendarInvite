# CalendarInvite

A single-admin self-hosted booking tool that publishes available time slots from connected calendars and lets end users book meetings instantly.

## Language

### Actors

**Admin**:
The single person who owns and configures the system. Manages booking profiles, calendar connections, and settings.
_Avoid_: User, owner, host

**Booker**:
An anonymous person visiting a public booking page to schedule a meeting with the Admin.
_Avoid_: End user, visitor, guest, client

### Core Concepts

**Booking Profile**:
An independent, publicly accessible booking configuration identified by a unique slug. Each profile has its own schedule, calendar sources, write target, meeting link, and attendee list.
_Avoid_: Link, page, calendar, config

**Booking**:
A confirmed meeting created when a Booker selects an available slot. Results in a calendar event on the write calendar.
_Avoid_: Appointment, event, meeting, reservation

**Calendar Connection**:
An authenticated OAuth2 link to an external calendar provider (Google, Microsoft, Zoho). Used for reading availability or writing events.
_Avoid_: Integration, account, provider

**Schedule Template**:
A recurring weekly pattern of available time ranges defined per Booking Profile. Each day of the week can have zero or more time ranges.
_Avoid_: Availability, timetable, weekly hours

**Schedule Override**:
A date-specific exception to the Schedule Template — either blocking an entire day or replacing it with custom time ranges.
_Avoid_: Exception, block, custom day

**Available Slot**:
A bookable time window derived from: Schedule Template minus Schedule Overrides minus Calendar Conflicts. Shown to the Booker.
_Avoid_: Free slot, open time, availability

**Cancellation Token**:
A unique, unguessable identifier embedded in a link that allows a Booker to cancel their own Booking without authentication.
_Avoid_: Cancel link, magic link, token

### Meeting Configuration

**Meeting Link**:
A static URL (Teams room or Google Meet room) assigned to a Booking Profile. Included in every calendar event created for that profile.
_Avoid_: Conference link, video link, room URL

**Default Attendees**:
A fixed list of email addresses per Booking Profile that are always invited to every Booking on that profile, in addition to the Booker.
_Avoid_: Recipients, participants, fixed attendees

### Calendar Operations

**Read Calendar**:
Querying a Calendar Connection for busy/free data to determine conflicts. Multiple connections can be read per profile.
_Avoid_: Sync, fetch, pull

**Write Calendar**:
The single Calendar Connection designated per Booking Profile where Booking events are created. The calendar provider sends native invitations to all attendees.
_Avoid_: Target calendar, destination, output calendar
