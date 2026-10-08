# Games Catalog

Vocabulary for Steam application identity and release metadata. A Steam product
is distinct from a curated, source-independent identity for a game.

## Language

**Steam Application**: A product on Steam identified by its Steam App ID. Its
product type can be Game, Demo, DLC, or another Steam classification; an
application is not automatically a canonical Game. _Avoid_: Steam release (when
referring to product identity), canonical Game

**Game**: A curated, source-independent identity for the underlying work. A Game
is not synonymous with a Steam Application or Steam's Game product type.
_Avoid_: App ID, Steam Application

**Steam Product Type**: Steam's classification of an application, such as Game,
Demo, or DLC. The Game classification does not assert a source-independent Game
identity. _Avoid_: canonical Game type

**Base Application**: The Steam Application explicitly identified by an approved
source as the base product for a demo or DLC. This relationship does not
establish canonical Game grouping. _Avoid_: parent Game

**Release Metadata**: Information about a Steam Application's release, including
its date or announced window and release status. It does not describe the
underlying work's original release across all platforms. _Avoid_: original game
release (when referring to a Steam application's release)

**Release Window**: A source-announced, non-exact period for release, such as a
quarter or year. A window is neither an exact date nor an unknown date. _Avoid_:
estimated release date (when implying invented day precision)

**Release Status**: The source-verified classification of a Steam Application's
release as upcoming, released, or unknown. An announced date alone does not
establish release status. _Avoid_: availability (when referring only to release
status)

**Publication Withdrawal**: An explicit decision to stop serving an
application's metadata from the catalog. It is distinct from upstream delisting
or absence from a source response. _Avoid_: Steam delisting

**Publication Eligibility**: Authorization for an application's metadata to be
published, subject to source approval and a valid observation. Eligibility does
not mean metadata exists or that the application has been released. _Avoid_:
published, released

**Publication Generation**: A version of an application's publication
authorization, replaced when its eligibility changes. Earlier-generation
observations are not authorized by reinstatement. _Avoid_: release version,
metadata version

**Publication Reinstatement**: An explicit decision to make a withdrawn
application eligible for publication under new authorization. It does not
restore previously withdrawn metadata. _Avoid_: metadata restoration, Steam
relisting
