/* Allow Jadges API requests and remote badge artwork without a host-permission popup. */

import { CspPolicies, ImageSrc } from "@main/csp";

CspPolicies["jadges.onrender.com"] = ImageSrc;
CspPolicies["cdn.discordapp.com"] = ImageSrc;
CspPolicies["media.discordapp.net"] = ImageSrc;
CspPolicies["discord.fandom.com"] = ImageSrc;
CspPolicies["static.wikia.nocookie.net"] = ImageSrc;
CspPolicies["raw.githubusercontent.com"] = ImageSrc;

export { installLatestUpdate } from "./updateNative";
