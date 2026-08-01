/* Allow Jadges API requests, remote theme CSS, and badge artwork without a host-permission popup. */

import { CspPolicies, ImageAndCssSrc, ImageSrc } from "@main/csp";

CspPolicies["jadges.onrender.com"] = ImageAndCssSrc;
CspPolicies["discord.fandom.com"] = ImageSrc;
CspPolicies["static.wikia.nocookie.net"] = ImageSrc;

export { installLatestUpdate } from "./updateNative";
